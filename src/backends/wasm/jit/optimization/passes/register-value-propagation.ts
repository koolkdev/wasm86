import type { JitIrBlock, JitIrBlockInstruction, JitIrOp } from "#backends/wasm/jit/ir/types.js";
import type { JitOptimizationPass } from "#backends/wasm/jit/optimization/pass.js";
import { jitIrOpIsTerminator } from "#backends/wasm/jit/ir/semantics.js";
import {
  assignRewritableJitValue,
  materializeJitRegisterValues,
  createJitInstructionRewrite,
  rewriteJitIrInstructionInto,
  type JitInstructionRewrite
} from "#backends/wasm/jit/ir/rewrite.js";
import {
  jitValueIsLegacyRewritable,
  type JitLegacyRewritableValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import {
  analyzeJitRegisterValues,
  validateJitRegisterValueAnalysis,
  type JitRegisterMaterialization,
  type JitRegisterValueAnalysis,
  type JitRegisterValueFold,
  type JitRegisterValueProducer
} from "#backends/wasm/jit/optimization/analyses/register-values.js";
import { analyzeJitBarriers } from "#backends/wasm/jit/ir/barriers.js";

export type JitRegisterValuePropagation = Readonly<{
  removedSetCount: number;
  foldedReadCount: number;
  foldedAddressCount: number;
  materializedSetCount: number;
}>;

export const registerValuePropagationPass = {
  name: "registerValuePropagation",
  run(block) {
    const result = propagateJitRegisterValues(block);

    return {
      block: result.block,
      changed: result.registerValuePropagation.removedSetCount !== 0 ||
        result.registerValuePropagation.foldedReadCount !== 0 ||
        result.registerValuePropagation.foldedAddressCount !== 0 ||
        result.registerValuePropagation.materializedSetCount !== 0,
      stats: result.registerValuePropagation
    };
  }
} satisfies JitOptimizationPass<"registerValuePropagation">;

export function propagateJitRegisterValues(block: JitIrBlock): Readonly<{
  block: JitIrBlock;
  registerValuePropagation: JitRegisterValuePropagation;
}> {
  const barriers = analyzeJitBarriers(block);
  const analysis = analyzeJitRegisterValues(block, barriers);
  validateJitRegisterValueAnalysis(analysis);
  const indexes = indexRegisterValueAnalysis(analysis);
  const stats = mutableStats();
  const instructions = block.instructions.map((instruction, instructionIndex) =>
    propagateInstructionRegisterValues(instruction, instructionIndex, indexes, stats)
  );

  return {
    block: { instructions },
    registerValuePropagation: stats
  };
}

function propagateInstructionRegisterValues(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  indexes: JitRegisterValuePropagationIndexes,
  stats: MutableJitRegisterValuePropagation
): JitIrBlockInstruction {
  const rewrite = createJitInstructionRewrite(instruction);
  stats.materializedSetCount += emitMaterializations(
    rewrite,
    indexes.materializationsBeforeInstruction.get(instructionIndex) ?? []
  );

  rewriteJitIrInstructionInto(
    instruction,
    instructionIndex,
    "propagating JIT register values",
    rewrite,
    ({ op, opIndex }) => {
      const key = registerValueAnalysisKey(instructionIndex, opIndex);
      const beforeExit = indexes.materializationsBeforeExit.get(key) ?? [];
      const isTerminator = jitIrOpIsTerminator(op);

      stats.materializedSetCount += emitMaterializations(
        rewrite,
        indexes.materializationsBeforeOp.get(key) ?? []
      );

      if (isTerminator) {
        stats.materializedSetCount += emitMaterializations(rewrite, beforeExit);
      }

      propagateOp(instruction, instructionIndex, op, opIndex, indexes, rewrite, stats);

      if (!isTerminator) {
        stats.materializedSetCount += emitMaterializations(rewrite, beforeExit);
      }
    }
  );

  return {
    ...instruction,
    ir: rewrite.ops
  };
}

function propagateOp(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  op: JitIrOp,
  opIndex: number,
  indexes: JitRegisterValuePropagationIndexes,
  rewrite: JitInstructionRewrite,
  stats: MutableJitRegisterValuePropagation
): void {
  switch (op.op) {
    case "get":
      propagateGet(instruction, instructionIndex, op, opIndex, indexes, rewrite, stats);
      break;
    case "address":
      propagateAddress(instruction, instructionIndex, op, opIndex, indexes, rewrite, stats);
      break;
    case "set":
      propagateSet(instruction, instructionIndex, op, opIndex, indexes, rewrite, stats);
      break;
    default:
      copyOp(instruction, op, rewrite);
      break;
  }
}

function propagateGet(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  op: Extract<JitIrOp, { op: "get" }>,
  opIndex: number,
  indexes: JitRegisterValuePropagationIndexes,
  rewrite: JitInstructionRewrite,
  stats: MutableJitRegisterValuePropagation
): void {
  const fold = indexes.folds.get(registerValueAnalysisKey(instructionIndex, opIndex));

  if (fold?.kind !== "get") {
    copyOp(instruction, op, rewrite);
    return;
  }

  assignTrackedValue(rewrite, op.dst.id, op.dst, fold.value);
  stats.foldedReadCount += 1;
}

function propagateAddress(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  op: Extract<JitIrOp, { op: "address" }>,
  opIndex: number,
  indexes: JitRegisterValuePropagationIndexes,
  rewrite: JitInstructionRewrite,
  stats: MutableJitRegisterValuePropagation
): void {
  const fold = indexes.folds.get(registerValueAnalysisKey(instructionIndex, opIndex));

  if (fold?.kind !== "address") {
    copyOp(instruction, op, rewrite);
    return;
  }

  assignTrackedValue(rewrite, op.dst.id, op.dst, fold.value);
  stats.foldedAddressCount += 1;
}

function propagateSet(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  op: Extract<JitIrOp, { op: "set" }>,
  opIndex: number,
  indexes: JitRegisterValuePropagationIndexes,
  rewrite: JitInstructionRewrite,
  stats: MutableJitRegisterValuePropagation
): void {
  const producer = indexes.producers.get(registerValueAnalysisKey(instructionIndex, opIndex));

  if (producer?.retained === true) {
    stats.removedSetCount += 1;
    return;
  }

  copyOp(instruction, op, rewrite);
}

function copyOp(
  instruction: JitIrBlockInstruction,
  op: JitIrOp,
  rewrite: JitInstructionRewrite
): void {
  rewrite.ops.push(op);
  rewrite.values.recordOp(op, instruction);
}

function assignTrackedValue(
  rewrite: JitInstructionRewrite,
  dstId: number,
  dst: Extract<JitIrOp, { op: "get" | "address" }>["dst"],
  value: JitValue
): void {
  assignRewritableJitValue(
    rewrite,
    dst,
    requiredLegacyRewritableValue(value, "register-value-propagation fold")
  );
  rewrite.values.record(dstId, value);
}

function emitMaterializations(
  rewrite: JitInstructionRewrite,
  materializations: readonly JitRegisterMaterialization[]
): number {
  let materializedSetCount = 0;

  for (const materialization of materializations) {
    materializedSetCount += materializeJitRegisterValues(
      rewrite,
      materialization.values.map(({ reg, value }) => ({
        reg,
        value: requiredLegacyRewritableValue(value, "register-value-propagation materialization")
      }))
    );
  }

  return materializedSetCount;
}

type JitRegisterValuePropagationIndexes = Readonly<{
  folds: ReadonlyMap<string, JitRegisterValueFold>;
  producers: ReadonlyMap<string, JitRegisterValueProducer>;
  materializationsBeforeInstruction: ReadonlyMap<number, readonly JitRegisterMaterialization[]>;
  materializationsBeforeOp: ReadonlyMap<string, readonly JitRegisterMaterialization[]>;
  materializationsBeforeExit: ReadonlyMap<string, readonly JitRegisterMaterialization[]>;
}>;

function indexRegisterValueAnalysis(
  analysis: JitRegisterValueAnalysis
): JitRegisterValuePropagationIndexes {
  const folds = new Map<string, JitRegisterValueFold>();
  const producers = new Map<string, JitRegisterValueProducer>();
  const materializationsBeforeInstruction = new Map<number, JitRegisterMaterialization[]>();
  const materializationsBeforeOp = new Map<string, JitRegisterMaterialization[]>();
  const materializationsBeforeExit = new Map<string, JitRegisterMaterialization[]>();

  for (const fold of analysis.folds) {
    folds.set(registerValueAnalysisKey(fold.instructionIndex, fold.opIndex), fold);
  }

  for (const producer of analysis.producers) {
    producers.set(registerValueAnalysisKey(producer.instructionIndex, producer.opIndex), producer);
  }

  for (const materialization of analysis.materializations) {
    switch (materialization.phase) {
      case "beforeInstruction":
        appendInstructionMaterialization(materializationsBeforeInstruction, materialization);
        break;
      case "beforeOp":
      case "blockEnd":
        appendOpMaterialization(materializationsBeforeOp, materialization);
        break;
      case "beforeExit":
        appendOpMaterialization(materializationsBeforeExit, materialization);
        break;
    }
  }

  return {
    folds,
    producers,
    materializationsBeforeInstruction,
    materializationsBeforeOp,
    materializationsBeforeExit
  };
}

function appendInstructionMaterialization(
  materializationsByInstruction: Map<number, JitRegisterMaterialization[]>,
  materialization: JitRegisterMaterialization
): void {
  const instructionMaterializations = materializationsByInstruction.get(materialization.instructionIndex);

  if (instructionMaterializations === undefined) {
    materializationsByInstruction.set(materialization.instructionIndex, [materialization]);
  } else {
    instructionMaterializations.push(materialization);
  }
}

function appendOpMaterialization(
  materializationsByOp: Map<string, JitRegisterMaterialization[]>,
  materialization: JitRegisterMaterialization
): void {
  if (materialization.opIndex === undefined) {
    throw new Error(`missing op index for register materialization: ${materialization.instructionIndex}`);
  }

  const key = registerValueAnalysisKey(materialization.instructionIndex, materialization.opIndex);
  const opMaterializations = materializationsByOp.get(key);

  if (opMaterializations === undefined) {
    materializationsByOp.set(key, [materialization]);
  } else {
    opMaterializations.push(materialization);
  }
}

function registerValueAnalysisKey(instructionIndex: number, opIndex: number): string {
  return `${instructionIndex}:${opIndex}`;
}

function requiredLegacyRewritableValue(value: JitValue, context: string): JitLegacyRewritableValue {
  if (jitValueIsLegacyRewritable(value)) {
    return value;
  }

  throw new Error(`${context} can only lower the legacy rewritable JitValue subset`);
}

type MutableJitRegisterValuePropagation = {
  removedSetCount: number;
  foldedReadCount: number;
  foldedAddressCount: number;
  materializedSetCount: number;
};

function mutableStats(): MutableJitRegisterValuePropagation {
  return {
    removedSetCount: 0,
    foldedReadCount: 0,
    foldedAddressCount: 0,
    materializedSetCount: 0
  };
}
