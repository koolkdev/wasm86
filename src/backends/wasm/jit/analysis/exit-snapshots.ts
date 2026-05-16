import type {
  IrExprBlock,
  IrExpressionSourceMap,
  IrExpressionSourcePlacement
} from "#backends/wasm/codegen/expressions.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  type ExitKind,
  type ExitSnapshot
} from "./exits.js";
import { snapshotForExit } from "./instruction-progress.js";
import {
  opView,
  requireValueExpr,
  type Timeline
} from "./timeline.js";
import { ValueStateBuilder } from "./value-state.js";

export type ExitSnapshotInstruction = Readonly<{
  instruction: JitInstruction;
  expressionBlock: IrExprBlock;
  sourceMap: IrExpressionSourceMap;
  valueTimeline: Timeline;
}>;

export type EffectExitSnapshotInput = Readonly<{
  kind: ExitKind;
  instruction: ExitSnapshotInstruction;
  sourceOpIndex: number;
  instructionCountDelta: number;
}>;

export function snapshotForEffectExit(input: EffectExitSnapshotInput): ExitSnapshot {
  const snapshot = exitSnapshotBeforeSourceOp(
    input.instruction,
    input.sourceOpIndex,
    input.instructionCountDelta
  );

  return snapshotForExit(
    input.kind,
    snapshotWithFaultRollback(input.kind, input.instruction, input.sourceOpIndex, snapshot)
  );
}

function exitSnapshotBeforeSourceOp(
  instruction: ExitSnapshotInstruction,
  sourceOpIndex: number,
  instructionCountDelta: number
): ExitSnapshot {
  return {
    instructionCountDelta,
    valueState: valueStateBeforeSourceOp(instruction, sourceOpIndex)
  };
}

function valueStateBeforeSourceOp(
  instruction: ExitSnapshotInstruction,
  sourceOpIndex: number
) {
  const expressionOpIndex = expressionOpIndexForSourceOp(instruction.sourceMap, sourceOpIndex, "source state");
  const snapshot = instruction.valueTimeline.snapshots[expressionOpIndex];

  if (snapshot === undefined) {
    throw new Error(`missing JIT value-state timeline snapshot for source op ${sourceOpIndex}`);
  }

  return snapshot;
}

function snapshotWithFaultRollback(
  kind: ExitKind,
  instruction: ExitSnapshotInstruction,
  sourceOpIndex: number,
  snapshot: ExitSnapshot
): ExitSnapshot {
  const sourceOp = instruction.instruction.ir[sourceOpIndex];

  if (
    sourceOp?.op !== "memory.guard" ||
    sourceOp.faultRollback === undefined ||
    !exitKindIsMemoryFault(kind)
  ) {
    return snapshot;
  }

  return applyFaultRollbackToSnapshot(instruction, sourceOpIndex, snapshot);
}

function applyFaultRollbackToSnapshot(
  instruction: ExitSnapshotInstruction,
  sourceOpIndex: number,
  snapshot: ExitSnapshot
): ExitSnapshot {
  const expressionOpIndex = expressionOpIndexForSourceOp(instruction.sourceMap, sourceOpIndex, "fault rollback");
  const expressionOp = instruction.expressionBlock[expressionOpIndex];
  const view = opView(instruction.valueTimeline, expressionOpIndex);
  const builder = new ValueStateBuilder(snapshot.valueState);

  if (expressionOp?.op !== "memory.guard") {
    throw new Error(`expected JIT fault rollback memory.guard expression op at ${expressionOpIndex}`);
  }

  for (const write of expressionOp.faultRollback ?? []) {
    builder.registers().recordReg32(
      write.target.reg,
      requireValueExpr(view, write.value, { nextEip: instruction.instruction.nextEip })
    );
  }

  return {
    ...snapshot,
    valueState: builder.snapshot()
  };
}

function exitKindIsMemoryFault(kind: ExitKind): boolean {
  return kind === "memoryReadFault" || kind === "memoryWriteFault";
}

function expressionOpIndexForSourceOp(
  sourceMap: IrExpressionSourceMap,
  sourceOpIndex: number,
  label: string
): number {
  const expressionOpIndexes = expressionOpIndexesForSourceOp(
    sourceMap,
    sourceOpIndex
  );

  if (expressionOpIndexes.length !== 1) {
    throw new Error(
      `expected one JIT expression op for ${label} ${sourceOpIndex}, got ${expressionOpIndexes.length}`
    );
  }

  return expressionOpIndexes[0]!;
}

function expressionOpIndexesForSourceOp(
  sourceMap: IrExpressionSourceMap,
  sourceOpIndex: number
): readonly number[] {
  return (sourceMap.placementsBySourceOpIndex.get(sourceOpIndex) ?? [])
    .filter(isEmittedExpressionOp)
    .map((placement) => placement.expressionOpIndex);
}

function isEmittedExpressionOp(
  placement: IrExpressionSourcePlacement
): boolean {
  return placement.kind === "emittedOp";
}
