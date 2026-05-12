import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
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
  emitJitGet
} from "./operands.js";
import type { JitExitPoint } from "#backends/wasm/jit/codegen/plan/types.js";
import type { JitExitTarget, JitIrState } from "#backends/wasm/jit/state/state.js";
import {
  type JitValueCacheRuntime
} from "./value-local-store.js";
import type { JitCodegenInstructionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import { emitJitRegisterMaterialization } from "./register-materialization.js";
import { emitJitSet } from "./operands.js";
import { emitJitInputSlot, emitJitInputSlotBits } from "./input-slots.js";

export type JitIrInstructionContext = JitCodegenInstructionPlan;

export type JitLinkResolver = Readonly<{
  moduleTable?: JitModuleLinkTable;
  functionIndexForStaticTarget?: (eip: number) => number | undefined;
  slotForStaticTarget?: (eip: number) => number;
}>;

export type JitLinkEmitContext = JitLinkResolver & Readonly<{
  blockTypeIndex: number;
  tableIndex?: number;
}>;

export type JitIrBlockEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  state: JitIrState;
  exit: JitExitTarget;
  instructions: readonly JitIrInstructionContext[];
  exitPoints: readonly JitExitPoint[];
  valueCache?: JitValueCacheRuntime | undefined;
  linking?: JitLinkEmitContext | undefined;
}>;

export type JitIrContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  state: JitIrState;
  exit: JitExitTarget;
  currentInstruction(): JitIrInstructionContext;
  currentExitPoint(exitReason: ExitReasonValue): JitExitPoint;
  completeExitPoint(exitPoint: JitExitPoint): void;
  advanceInstruction(): void;
  valueCache?: JitValueCacheRuntime | undefined;
  linking?: JitLinkEmitContext | undefined;
}>;

export function emitJitIrWithContext(context: JitIrBlockEmitContext): void {
  const jitContext = createJitIrContext(context);

  for (let index = 0; index < context.instructions.length; index += 1) {
    jitContext.valueCache?.beginInstruction(index);
    beginInstruction(jitContext, context.exit, jitContext.currentInstruction());
    emitCurrentInstruction(jitContext);
  }
}

function createJitIrContext(context: JitIrBlockEmitContext): JitIrContext {
  let instructionIndex = 0;
  let completedPreInstructionExitPointCount = 0;
  const exitPointsByKey = indexExitPoints(context.exitPoints);
  const exitPointUseCounts = new Map<string, number>();

  return {
    body: context.body,
    scratch: context.scratch,
    state: context.state,
    exit: context.exit,
    valueCache: context.valueCache,
    linking: context.linking,
    currentInstruction: () => {
      const instruction = context.instructions[instructionIndex];

      if (instruction === undefined) {
        throw new Error(`missing JIT IR instruction context: ${instructionIndex}`);
      }

      return instruction;
    },
    currentExitPoint: (exitReason) => {
      const key = exitPointKey(instructionIndex, exitReason);
      const exitPoints = exitPointsByKey.get(key) ?? [];
      const useCount = exitPointUseCounts.get(key) ?? 0;
      const exitPoint = exitPoints[useCount];

      if (exitPoint === undefined) {
        throw new Error(`missing JIT exit point for instruction ${instructionIndex} reason ${exitReason}`);
      }

      exitPointUseCounts.set(key, useCount + 1);
      return exitPoint;
    },
    completeExitPoint: (exitPoint) => {
      if (exitPoint.snapshot.kind !== "preInstruction") {
        return;
      }

      completedPreInstructionExitPointCount += 1;

      const instruction = context.instructions[instructionIndex];

      if (instruction === undefined) {
        throw new Error(`missing JIT IR instruction context: ${instructionIndex}`);
      }

      const expectedPreInstructionExitPointCount = instruction.entryPoint.preInstructionExitPlan?.exitPointCount ?? 0;

      if (completedPreInstructionExitPointCount > expectedPreInstructionExitPointCount) {
        throw new Error(`completed too many JIT pre-instruction exit points: ${instructionIndex}`);
      }

      if (completedPreInstructionExitPointCount === expectedPreInstructionExitPointCount) {
        context.state.finishPreInstructionExitPoints();
      }
    },
    advanceInstruction: () => {
      instructionIndex += 1;
      completedPreInstructionExitPointCount = 0;
    }
  };
}

function emitCurrentInstruction(jitContext: JitIrContext): void {
  emitJitIrBlock(jitContext, jitContext.currentInstruction());
}

function emitJitIrBlock(jitContext: JitIrContext, instruction: JitIrInstructionContext): void {
  const valueCache = jitContext.valueCache;

  emitJitExpressionBlock({
    body: jitContext.body,
    instruction,
    valueCache,
    emitInput: (slot) => emitJitInputSlot(jitContext.body, slot),
    emitInputBits: (slot, bitOffset, width, signed) =>
      emitJitInputSlotBits(jitContext.body, slot, bitOffset, width, signed),
    emitGet: (source, accessWidth, helpers, options) =>
      emitJitGet(jitContext, source, accessWidth, helpers, options),
    emitSet: (op, helpers) => {
      if (op.role === "registerMaterialization") {
        emitJitRegisterMaterialization(jitContext, valueCache, op.target, op.value, op.accessWidth, helpers);
        return;
      }

      emitJitSet(jitContext, op.target, op.value, op.accessWidth, helpers);
    },
    emitAddress: (source) => emitJitAddress(jitContext, source),
    emitSetFlags: (descriptor, helpers) =>
      jitContext.state.flags.emitSet(descriptor, helpers),
    emitNext: (helpers) => {
      void helpers;
      emitJitNext(jitContext);
    },
    emitNextEip: (helpers) => {
      void helpers;
      emitJitNextEip(jitContext);
      return cleanValueWidth(32);
    },
    emitJump: (target, helpers) => emitJitJump(jitContext, target, helpers),
    emitConditionalJump: (condition, taken, notTaken, helpers) =>
      emitJitConditionalJump(jitContext, condition, taken, notTaken, helpers),
    emitHostTrap: (vector, helpers) => emitJitHostTrap(jitContext, vector, helpers)
  });
}

function beginInstruction(
  context: Pick<JitIrContext, "state">,
  exit: JitExitTarget,
  instruction: JitIrInstructionContext
): void {
  context.state.beginInstruction(exit, instruction.entryPoint);
}

function indexExitPoints(exitPoints: readonly JitExitPoint[]): ReadonlyMap<string, readonly JitExitPoint[]> {
  const exitPointsByKey = new Map<string, JitExitPoint[]>();

  for (const exitPoint of exitPoints) {
    const key = exitPointKey(exitPoint.instructionIndex, exitPoint.exitReason);
    const instructionExitPoints = exitPointsByKey.get(key);

    if (instructionExitPoints === undefined) {
      exitPointsByKey.set(key, [exitPoint]);
    } else {
      instructionExitPoints.push(exitPoint);
    }
  }

  return exitPointsByKey;
}

function exitPointKey(instructionIndex: number, exitReason: ExitReasonValue): string {
  return `${instructionIndex}:${exitReason}`;
}
