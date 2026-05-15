import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { JitModuleLinkTable } from "#backends/wasm/jit/compiled-blocks/module-link-table.js";
import { cleanValueWidth } from "#backends/wasm/codegen/value-width.js";
import { emitJitExpressionBlock } from "./expression-block.js";
import {
  emitJitConditionalJump,
  emitJitHostTrap,
  emitJitJump,
  emitJitNext,
  emitJitNextEip
} from "./control.js";
import {
  emitJitAddress,
  emitJitGet,
  emitJitMemoryGuard
} from "./operands.js";
import type { JitExitTarget, JitState } from "#backends/wasm/jit/state/state.js";
import {
  type JitValueCacheRuntime
} from "./value-local-store.js";
import type { JitCodegenInstructionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import type { JitPlannedEffect } from "#backends/wasm/jit/codegen/plan/effect-plan.js";
import { opView, type OpView } from "#backends/wasm/jit/analysis/timeline.js";
import { emitJitSet } from "./operands.js";
import { emitJitInputSlot, emitJitInputSlotBits } from "./input-slots.js";

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
  plannedEffects: readonly JitPlannedEffect[];
  valueCache?: JitValueCacheRuntime | undefined;
  linking?: JitLinkEmitContext | undefined;
}>;

export type JitInstructionEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  state: JitState;
  exit: JitExitTarget;
  selectInstruction(index: number): void;
  currentInstruction(): JitInstructionContext;
  beginExpressionOp(opIndex: number): OpView;
  advanceInstruction(): void;
  valueCache?: JitValueCacheRuntime | undefined;
  linking?: JitLinkEmitContext | undefined;
}>;

export function emitJitBlock(context: JitBlockEmitContext): void {
  const jitContext = createJitInstructionEmitContext(context);
  const plannedEffectsByInstruction = groupPlannedEffectsByInstruction(
    context.plannedEffects,
    context.instructions.length
  );

  for (let index = 0; index < context.instructions.length; index += 1) {
    jitContext.selectInstruction(index);
    jitContext.valueCache?.beginInstruction(index);
    beginInstruction(jitContext, context.exit, jitContext.currentInstruction());
    emitCurrentInstruction(jitContext, plannedEffectsByInstruction[index]!);
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
    beginExpressionOp: (opIndex) => {
      const instruction = context.instructions[instructionIndex];

      if (instruction === undefined) {
        throw new Error(`missing JIT IR instruction context: ${instructionIndex}`);
      }

      const timelineOp = opView(instruction.valueTimeline, opIndex);

      context.valueCache?.beginExpressionOp(opIndex);
      return timelineOp;
    },
    advanceInstruction: () => {
      instructionIndex += 1;
    }
  };
}

function emitCurrentInstruction(
  jitContext: JitInstructionEmitContext,
  plannedEffects: readonly JitPlannedEffect[]
): void {
  emitJitInstruction(jitContext, jitContext.currentInstruction(), plannedEffects);
}

function emitJitInstruction(
  jitContext: JitInstructionEmitContext,
  instruction: JitInstructionContext,
  plannedEffects: readonly JitPlannedEffect[]
): void {
  const valueCache = jitContext.valueCache;
  let currentTimelineOp: OpView | undefined;

  emitJitExpressionBlock({
    body: jitContext.body,
    instruction: { ...instruction, plannedEffects },
    valueCache,
    beginExpressionOp: (opIndex) => {
      currentTimelineOp = jitContext.beginExpressionOp(opIndex);
    },
    emitInput: (slot) => emitJitInputSlot(jitContext.body, slot),
    emitInputBits: (slot, bitOffset, width, signed) =>
      emitJitInputSlotBits(jitContext.body, slot, bitOffset, width, signed),
    emitGet: (source, accessWidth, helpers, options) =>
      emitJitGet(jitContext, requiredCurrentTimelineOp(currentTimelineOp), source, accessWidth, helpers, options),
    emitSet: (op, helpers) =>
      emitJitSet(jitContext, requiredCurrentTimelineOp(currentTimelineOp), op.target, op.value, op.accessWidth, helpers),
    emitMemoryGuard: (op, effect, helpers) =>
      emitJitMemoryGuard(jitContext, op.address, op.byteLength, op.access, effect.faultExit, helpers),
    emitAddress: (source, helpers) => emitJitAddress(
      jitContext,
      requiredCurrentTimelineOp(currentTimelineOp),
      source,
      helpers
    ),
    emitNext: (effect) => emitJitNext(jitContext, effect),
    emitNextEip: () => {
      emitJitNextEip(jitContext);
      return cleanValueWidth(32);
    },
    emitJump: (target, effect, helpers) => emitJitJump(jitContext, target, effect, helpers),
    emitConditionalJump: (condition, taken, notTaken, effect, helpers) =>
      emitJitConditionalJump(jitContext, condition, taken, notTaken, effect, helpers),
    emitHostTrap: (vector, effect, helpers) => emitJitHostTrap(jitContext, vector, effect, helpers)
  });
}

function requiredCurrentTimelineOp(timelineOp: OpView | undefined): OpView {
  if (timelineOp === undefined) {
    throw new Error("JIT expression op context requested before emission started");
  }

  return timelineOp;
}

function beginInstruction(
  context: Pick<JitInstructionEmitContext, "state">,
  exit: JitExitTarget,
  instruction: JitInstructionContext
): void {
  context.state.beginInstruction(exit, instruction.instructionCountDelta, instruction.eip);
}

function groupPlannedEffectsByInstruction(
  plannedEffects: readonly JitPlannedEffect[],
  instructionCount: number
): readonly (readonly JitPlannedEffect[])[] {
  const grouped: JitPlannedEffect[][] = Array.from(
    { length: instructionCount },
    () => []
  );

  for (const effect of plannedEffects) {
    const instructionEffects = grouped[effect.placement.instructionIndex];

    if (instructionEffects === undefined) {
      throw new Error(
        `JIT planned effect references missing instruction: ${effect.placement.instructionIndex}`
      );
    }

    instructionEffects.push(effect);
  }

  return grouped;
}
