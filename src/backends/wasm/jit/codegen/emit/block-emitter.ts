import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import {
  cleanValueWidth,
  emitCleanValueForFullUse,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import {
  emitWasmIrExitFromI32Stack,
  type WasmIrExitDestination
} from "#backends/wasm/codegen/exit.js";
import {
  type ValueCache
} from "./cache.js";
import type { ExitMetadataEmitter } from "./exit-metadata.js";
import {
  createControlExitEmitter,
  type ControlExitEmitter,
  type ControlExitEmitterContext,
  type JitLinkEmitContext
} from "./control-exits.js";
import {
  createExitFrame,
  type ExitStoreLayout,
  type ExitFrame
} from "./exit-frame.js";
import type { ExitStoreEmitter } from "./exit-stores.js";
import type { JitCodegenInstructionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import type {
  Effect,
  EffectsPlan
} from "#backends/wasm/jit/codegen/plan/effect-types.js";
import { opView, type OpView } from "#backends/wasm/jit/analysis/timeline.js";
import { createInputSlotEmitter } from "./input-slots.js";
import {
  createValueEmitter,
  unavailableProducedEmitter,
  type ValueEmitOptions,
  type ValueEmitter
} from "./values.js";
import {
  emitWasmIrGuardGuestRange,
  emitWasmIrLoadGuestUnchecked,
  emitWasmIrStoreGuestUnchecked
} from "#backends/wasm/codegen/memory.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { ExitReason } from "#backends/wasm/exit.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";

export type JitInstructionContext = JitCodegenInstructionPlan;

export type JitBlockEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  metadata: ExitMetadataEmitter;
  stores: ExitStoreEmitter;
  exitStoreLayout: ExitStoreLayout;
  exitLocal: number;
  instructions: readonly JitInstructionContext[];
  effects: EffectsPlan;
  valueCache?: ValueCache | undefined;
  linking?: JitLinkEmitContext | undefined;
}>;

export type JitInstructionEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  controlExits: ControlExitEmitter;
  exitFrame: ExitFrame;
  selectInstruction(index: number): void;
  currentInstruction(): JitInstructionContext;
  beginOp(opIndex: number): OpView;
  values: ValueEmitter;
  valueCache?: ValueCache | undefined;
}>;

export function emitJitBlock(context: JitBlockEmitContext): void {
  const jitContext = createJitInstructionEmitContext(context);
  const effectsByInstruction = groupEffectsByInstruction(
    context.effects,
    context.instructions.length
  );

  jitContext.exitFrame.openDeferredBlocks();

  for (let index = 0; index < context.instructions.length; index += 1) {
    jitContext.selectInstruction(index);
    jitContext.valueCache?.beginInstruction(index);
    emitCurrentInstruction(jitContext, effectsByInstruction[index]!);
  }

  jitContext.exitFrame.emitDeferredReturns();
}

function createJitInstructionEmitContext(context: JitBlockEmitContext): JitInstructionEmitContext {
  let instructionIndex = 0;
  const values = createValueEmitter({
    body: context.body,
    cache: context.valueCache,
    inputs: createInputSlotEmitter(context.body),
    produced: unavailableProducedEmitter()
  });
  const frame = createExitFrame({
    body: context.body,
    metadata: context.metadata,
    stores: context.stores,
    layout: context.exitStoreLayout,
    exitLocal: context.exitLocal
  });
  const exitContext = {
    body: context.body,
    scratch: context.scratch,
    values,
    frame,
    valueCache: context.valueCache,
    linking: context.linking
  } satisfies ControlExitEmitterContext;
  const controlExits = createControlExitEmitter(exitContext);

  return {
    body: exitContext.body,
    scratch: exitContext.scratch,
    controlExits,
    exitFrame: exitContext.frame,
    valueCache: exitContext.valueCache,
    selectInstruction: (index) => {
      if (index < 0 || index >= context.instructions.length) {
        throw new Error(`JIT instruction index out of range: ${index}`);
      }

      instructionIndex = index;
    },
    currentInstruction: () => {
      const instruction = context.instructions[instructionIndex];

      if (instruction === undefined) {
        throw new Error(`missing JIT IR instruction context: ${instructionIndex}`);
      }

      return instruction;
    },
    beginOp: (opIndex) => {
      const instruction = context.instructions[instructionIndex];

      if (instruction === undefined) {
        throw new Error(`missing JIT IR instruction context: ${instructionIndex}`);
      }

      const timelineOp = opView(instruction.valueTimeline, opIndex);

      exitContext.valueCache?.beginOp(opIndex);
      return timelineOp;
    },
    values: exitContext.values
  };
}

function emitCurrentInstruction(
  jitContext: JitInstructionEmitContext,
  effects: readonly Effect[]
): void {
  emitJitInstruction(jitContext, jitContext.currentInstruction(), effects);
}

function emitJitInstruction(
  jitContext: JitInstructionEmitContext,
  instruction: JitInstructionContext,
  effects: readonly Effect[]
): void {
  void instruction;

  for (const effect of effects) {
    jitContext.beginOp(effect.at.opIndex);
    captureValues(jitContext, effect.at.opIndex);
    emitEffect(jitContext, effect);
  }
}

function emitEffect(
  context: JitInstructionEmitContext,
  effect: Effect
): void {
  switch (effect.kind) {
    case "memoryGuard":
      return emitMemoryGuard(context, effect);
    case "memoryStore":
      return emitMemoryStore(context, effect);
    case "producedValue":
      return emitProducedValue(context, effect);
    case "jump":
      return context.controlExits.emitJump(effect.target, effect.exit);
    case "branch":
      return context.controlExits.emitBranch(
        effect.condition,
        { target: effect.takenTarget, exit: effect.taken },
        { target: effect.notTakenTarget, exit: effect.notTaken }
      );
    case "hostTrap":
      return context.controlExits.emitHostTrap(effect.vector, effect.exit);
    case "fallthrough":
      return context.controlExits.emitFallthrough(effect.exit);
  }
}

function emitMemoryGuard(
  context: JitInstructionEmitContext,
  effect: Extract<Effect, { kind: "memoryGuard" }>
): void {
  const addressLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    emitEffectValue(context, effect.address, { requestedWidth: 32 });
    context.body.localSet(addressLocal);

    assertMemoryFaultExit(effect);
    context.valueCache?.enterPath(effect.exit.path);
    let destination: WasmIrExitDestination | undefined;

    try {
      destination = context.exitFrame.captureDestination(effect.exit);
    } finally {
      context.valueCache?.leavePath();
    }

    if (destination === undefined) {
      throw new Error(`JIT memory fault exit was not prepared: ${effect.exit.id}`);
    }

    emitWasmIrGuardGuestRange(
      {
        body: context.body,
        emitFaultExit: (fault) => {
          context.exitFrame.emitMetadata(effect.exit);
          emitWasmIrExitFromI32Stack(context.body, {
            destination,
            reason: effect.exit.reason,
            extraDepth: fault.extraDepth,
            detail: fault.byteLength
          });
        }
      },
      addressLocal,
      effect.byteLength
    );
  } finally {
    context.scratch.freeLocal(addressLocal);
  }
}

function emitMemoryStore(
  context: JitInstructionEmitContext,
  effect: Extract<Effect, { kind: "memoryStore" }>
): void {
  emitWasmIrStoreGuestUnchecked(
    context.body,
    () => {
      emitEffectValue(context, effect.address, { requestedWidth: 32 });
    },
    () => {
      const valueWidth = emitEffectValue(context, effect.value);

      if (effect.accessWidth === 32) {
        emitCleanValueForFullUse(context.body, valueWidth);
      }
    },
    effect.accessWidth
  );
}

function emitProducedValue(
  context: JitInstructionEmitContext,
  effect: Extract<Effect, { kind: "producedValue" }>
): void {
  const captured = context.valueCache?.capture(
    effect.value,
    () => emitProducedLoad(context, effect)
  );

  captured?.release();
}

function emitProducedLoad(
  context: JitInstructionEmitContext,
  effect: Extract<Effect, { kind: "producedValue" }>
): ValueWidth {
  emitWasmIrLoadGuestUnchecked(
    context.body,
    () => {
      emitEffectValue(context, effect.address, { requestedWidth: 32 });
    },
    effect.accessWidth,
    effect.signed
  );

  return signedLoadValueWidth(effect.accessWidth, effect.signed);
}

function signedLoadValueWidth(width: 8 | 16 | 32, signed: boolean): ValueWidth {
  if (signed && width < 32) {
    return cleanValueWidth(32);
  }

  return cleanValueWidth(width);
}

function emitEffectValue(
  context: JitInstructionEmitContext,
  value: JitValue,
  options: ValueEmitOptions = {}
): ValueWidth {
  return context.values.emit(value, options);
}

function captureValues(
  context: JitInstructionEmitContext,
  opIndex: number
): void {
  const captures = context.currentInstruction().captureMap.get(opIndex) ?? [];

  for (const capture of captures) {
    if (capture.value.kind === "produced") {
      throw new Error("produced JIT values are captured at their definition");
    }

    const captured = context.valueCache?.capture(
      capture.value,
      () => context.values.emitInline(capture.value)
    );

    captured?.release();
  }
}

function assertMemoryFaultExit(
  effect: Extract<Effect, { kind: "memoryGuard" }>
): void {
  const expected = effect.access === "read"
    ? ExitReason.MEMORY_READ_FAULT
    : ExitReason.MEMORY_WRITE_FAULT;

  if (effect.exit.reason !== expected) {
    throw new Error(`JIT memory ${effect.access} guard received exit reason ${effect.exit.reason}`);
  }
}

function groupEffectsByInstruction(
  effects: readonly Effect[],
  instructionCount: number
): readonly (readonly Effect[])[] {
  const grouped: Effect[][] = Array.from(
    { length: instructionCount },
    () => []
  );

  for (const effect of effects) {
    const instructionEffects = grouped[effect.at.instructionIndex];

    if (instructionEffects === undefined) {
      throw new Error(
        `JIT effects plan references missing instruction: ${effect.at.instructionIndex}`
      );
    }

    instructionEffects.push(effect);
  }

  return grouped;
}
