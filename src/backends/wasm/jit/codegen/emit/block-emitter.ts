import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import {
  type ValueCache
} from "./cache.js";
import type { ExitMetadataEmitter } from "./exit-metadata.js";
import {
  createControlEffectsEmitter,
  type ControlEffectsEmitter,
  type ControlEffectsEmitterContext,
  type JitLinkEmitContext
} from "./control-effects.js";
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
  type ValueEmitter
} from "./values.js";
import {
  createMemoryEffectsEmitter,
  type MemoryEffectsEmitter
} from "./memory-effects.js";

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
  controlEffects: ControlEffectsEmitter;
  exitFrame: ExitFrame;
  selectInstruction(index: number): void;
  currentInstruction(): JitInstructionContext;
  beginOp(opIndex: number): OpView;
  values: ValueEmitter;
  memoryEffects: MemoryEffectsEmitter;
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
  } satisfies ControlEffectsEmitterContext;
  const controlEffects = createControlEffectsEmitter(exitContext);
  const memoryEffects = createMemoryEffectsEmitter({
    body: context.body,
    scratch: context.scratch,
    values,
    exitFrame: frame,
    valueCache: context.valueCache
  });

  return {
    controlEffects,
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
    values: exitContext.values,
    memoryEffects
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
    case "memoryStore":
    case "memoryLoad":
      return context.memoryEffects.emit(effect);
    case "jump":
    case "branch":
    case "hostTrap":
    case "fallthrough":
      return context.controlEffects.emit(effect);
  }
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
