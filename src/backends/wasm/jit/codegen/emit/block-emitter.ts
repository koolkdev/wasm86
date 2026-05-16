import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { JitModuleLinkTable } from "#backends/wasm/jit/compiled-blocks/module-link-table.js";
import {
  cleanValueWidth,
  emitCleanValueForFullUse,
  type ValueWidth,
  type WasmIrEmitValueOptions
} from "#backends/wasm/codegen/value-width.js";
import {
  emitJitConditionalJump,
  emitJitHostTrap,
  emitJitJump,
  emitJitNext,
} from "./control.js";
import type { JitExitTarget, JitState } from "#backends/wasm/jit/state/state.js";
import {
  type ValueCache
} from "./cache.js";
import type { JitCodegenInstructionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import type {
  Effect,
  EffectsPlan
} from "#backends/wasm/jit/codegen/plan/effect-types.js";
import { opView, type OpView } from "#backends/wasm/jit/analysis/timeline.js";
import { emitJitInputSlot, emitJitInputSlotBits } from "./input-slots.js";
import {
  emitJitValue,
  emitJitValueWithoutRootCache,
  type JitValueEmitContext
} from "./jit-values.js";
import {
  emitWasmIrGuardGuestRange,
  emitWasmIrLoadGuestUnchecked,
  emitWasmIrStoreGuestUnchecked
} from "#backends/wasm/codegen/memory.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { ExitReason } from "#backends/wasm/exit.js";

export type JitInstructionContext = JitCodegenInstructionPlan;

export type JitLinkResolver = Readonly<{
  moduleTable?: JitModuleLinkTable;
  functionIndexForStaticTarget?: (eip: number) => number | undefined;
  slotForStaticTarget?: (eip: number) => number;
}>;

export type JitLinkEmitContext = JitLinkResolver & Readonly<{
  blockTypeIndex: number;
  tableIndex?: number;
}>;

export type JitBlockEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  state: JitState;
  exit: JitExitTarget;
  instructions: readonly JitInstructionContext[];
  effects: EffectsPlan;
  valueCache?: ValueCache | undefined;
  linking?: JitLinkEmitContext | undefined;
}>;

export type JitInstructionEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  state: JitState;
  exit: JitExitTarget;
  selectInstruction(index: number): void;
  currentInstruction(): JitInstructionContext;
  beginOp(opIndex: number): OpView;
  jitValueEmitContext(): JitValueEmitContext;
  advanceInstruction(): void;
  valueCache?: ValueCache | undefined;
  linking?: JitLinkEmitContext | undefined;
}>;

export function emitJitBlock(context: JitBlockEmitContext): void {
  const jitContext = createJitInstructionEmitContext(context);
  const effectsByInstruction = groupEffectsByInstruction(
    context.effects,
    context.instructions.length
  );

  for (let index = 0; index < context.instructions.length; index += 1) {
    jitContext.selectInstruction(index);
    jitContext.valueCache?.beginInstruction(index);
    beginInstruction(jitContext, context.exit, jitContext.currentInstruction());
    emitCurrentInstruction(jitContext, effectsByInstruction[index]!);
  }
}

function createJitInstructionEmitContext(context: JitBlockEmitContext): JitInstructionEmitContext {
  let instructionIndex = 0;

  return {
    body: context.body,
    scratch: context.scratch,
    state: context.state,
    exit: context.exit,
    valueCache: context.valueCache,
    linking: context.linking,
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

      context.valueCache?.beginOp(opIndex);
      return timelineOp;
    },
    jitValueEmitContext: () => ({
      body: context.body,
      valueCache: context.valueCache,
      emitInput: (slot) => emitJitInputSlot(context.body, slot),
      emitInputBits: (slot, bitOffset, width, signed) =>
        emitJitInputSlotBits(context.body, slot, bitOffset, width, signed)
    }),
    advanceInstruction: () => {
      instructionIndex += 1;
    }
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

function beginInstruction(
  context: Pick<JitInstructionEmitContext, "state">,
  exit: JitExitTarget,
  instruction: JitInstructionContext
): void {
  context.state.beginInstruction(exit, instruction.instructionCountDelta, instruction.eip);
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
      return emitJitJump(context, effect);
    case "branch":
      return emitJitConditionalJump(context, effect);
    case "hostTrap":
      return emitJitHostTrap(context, effect);
    case "fallthrough":
      return emitJitNext(context, effect);
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
    context.state.prepareExitPoint(effect.exit);

    emitWasmIrGuardGuestRange(context, addressLocal, effect.byteLength, effect.access);
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
  value: Parameters<typeof emitJitValue>[1],
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  return emitJitValue(context.jitValueEmitContext(), value, options);
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
      () => emitJitValueWithoutRootCache(context.jitValueEmitContext(), capture.value)
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
