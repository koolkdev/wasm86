import {
  buildIrExpressionBlock,
  type IrExpressionOptions,
  type IrExprBlock
} from "#backends/wasm/codegen/expressions.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
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
  JitInstructionState
} from "./types.js";

export type JitCodegenInstructionPlan = JitInstructionState & Pick<
  JitIrBlockInstruction,
  "operands"
> & Readonly<{
  expressionBlock: IrExprBlock;
  valueCachePlan?: JitExpressionValueCachePlan;
}>;

export type JitCodegenEmissionPlan = Readonly<{
  instructions: readonly JitCodegenInstructionPlan[];
  exitPoints: readonly JitExitPoint[];
  flagMaterializationRequirements: readonly JitFlagMaterializationRequirement[];
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

    const expressionBlock = buildIrExpressionBlock(instruction.ir, jitExpressionOptions(instruction));

    return {
      ...state,
      operands: instruction.operands,
      expressionBlock
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
      materializedValueExpressionUseIndexes: expressionUseIndexesByInstruction[index] ?? new Set()
    }))
  );

  return {
    instructions: valueCachePlan === undefined
      ? instructions
      : instructions.map((instruction) => ({ ...instruction, valueCachePlan })),
    exitPoints: codegenPlan.exitPoints,
    flagMaterializationRequirements: codegenPlan.flagMaterializationRequirements,
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
