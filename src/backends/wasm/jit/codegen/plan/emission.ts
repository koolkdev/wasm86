import {
  type IrExpressionOptions,
  type IrExprBlock,
  type IrExpressionSourceMap,
  buildIrExpressionBlockWithSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { indexProducedValuesByVarIdForInstruction } from "#backends/wasm/jit/ir/produced-values.js";
import {
  canInlineJitInstructionGet,
  jitInstructionStorageRefsMayAlias
} from "./operand-analysis.js";
import { planJitMaterializedValueUses } from "./materialized-values.js";
import {
  planJitExpressionValueCacheForInstructions,
  type JitExpressionValueCachePlan
} from "./value-cache.js";
import type {
  JitCodegenPlan,
  JitExitPoint,
  JitExitMaterializationPlan,
  JitFlagMaterializationRequirement,
  JitMaterializationNeed,
  JitInstructionState
} from "./types.js";

export type JitCodegenInstructionPlan = JitInstructionState & Pick<
  JitIrBlockInstruction,
  "operands"
> & Readonly<{
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
  valueCachePlan?: JitExpressionValueCachePlan;
}>;

export type JitCodegenEmissionPlan = Readonly<{
  instructions: readonly JitCodegenInstructionPlan[];
  exitPoints: readonly JitExitPoint[];
  flagMaterializationRequirements: readonly JitFlagMaterializationRequirement[];
  materializationNeeds: readonly JitMaterializationNeed[];
  exitMaterializations: readonly JitExitMaterializationPlan[];
  maxExitMaterializationIndex: number;
  valueCachePlan?: JitExpressionValueCachePlan;
}>;

export function buildJitCodegenEmissionPlan(codegenPlan: JitCodegenPlan): JitCodegenEmissionPlan {
  const block = codegenPlan.block;

  if (block.instructions.length !== codegenPlan.instructionStates.length) {
    throw new Error(
      `JIT codegen instruction count mismatch: ${block.instructions.length} !== ${codegenPlan.instructionStates.length}`
    );
  }

  const instructions = block.instructions.map((instruction, index) => {
    const state = codegenPlan.instructionStates[index];

    if (state === undefined) {
      throw new Error(`missing JIT instruction state for codegen: ${index}`);
    }

    const expressionPlan = buildIrExpressionBlockWithSourceMap(
      instruction.ir,
      jitExpressionOptions(instruction)
    );
    const producedValuesByVarId = indexProducedValuesByVarIdForInstruction(instruction, index);

    return {
      ...state,
      operands: instruction.operands,
      producedValuesByVarId,
      expressionBlock: expressionPlan.expressionBlock,
      sourceExpressionMap: expressionPlan.sourceMap
    };
  });
  const materializedValueUsePlan = planJitMaterializedValueUses(
    instructions,
    codegenPlan
  );
  const { expressionUseIndexesByInstruction } = materializedValueUsePlan;
  const valueCachePlan = planJitExpressionValueCacheForInstructions(
    instructions.map((instruction, index) => ({
      operands: instruction.operands,
      expressionBlock: instruction.expressionBlock,
      producedValuesByVarId: instruction.producedValuesByVarId,
      materializedValueExpressionUseIndexes: expressionUseIndexesByInstruction[index] ?? new Set()
    }))
  );

  return {
    instructions: valueCachePlan === undefined
      ? instructions
      : instructions.map((instruction) => ({ ...instruction, valueCachePlan })),
    exitPoints: codegenPlan.exitPoints,
    flagMaterializationRequirements: codegenPlan.flagMaterializationRequirements,
    materializationNeeds: codegenPlan.materializationNeeds,
    exitMaterializations: codegenPlan.exitMaterializations,
    maxExitMaterializationIndex: codegenPlan.maxExitMaterializationIndex,
    ...(valueCachePlan === undefined ? {} : { valueCachePlan })
  };
}

function jitExpressionOptions(instruction: Pick<JitIrBlockInstruction, "operands">): IrExpressionOptions {
  return {
    canInlineGet: (source) => canInlineJitInstructionGet(instruction, source),
    alias: {
      storageMayAlias: (write, read) => jitInstructionStorageRefsMayAlias(instruction, write, read)
    }
  };
}
