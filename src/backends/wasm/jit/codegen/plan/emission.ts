import {
  type IrExpressionOptions,
  type IrExprBlock,
  type IrExpressionSourceMap,
  buildIrExpressionBlockWithSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { indexProducedValuesByVarIdForInstruction } from "#backends/wasm/jit/ir/produced-values.js";
import type {
  JitProducedValue
} from "#backends/wasm/jit/ir/values.js";
import type { JitExpressionValueCachePlan } from "./value-cache.js";
import {
  buildJitInstructionValueTimeline,
  type JitInstructionValueTimeline
} from "./value-timeline.js";
import type {
  JitCodegenPlan,
  JitExitPoint,
  JitExitMaterializationPlan,
  JitMaterializationNeed,
  JitInstructionState
} from "./types.js";
import {
  canInlineJitInstructionGet,
  jitInstructionStorageRefsMayAlias
} from "./operand-analysis.js";
import {
  planJitValuesForEmission,
  type JitInstructionWithPlannedValues
} from "./value-planning.js";
import type { JitPlannedValueUse } from "./value-uses.js";
import type {
  JitPlannedValueCapture
} from "./value-captures.js";
import {
  buildJitExpressionControlPathScopes,
  type JitControlPathScopesMap
} from "./control-paths.js";

type JitPreparedCodegenInstruction = JitInstructionState & Pick<
  JitIrBlockInstruction,
  "operands"
> & Readonly<{
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
  expressionPathScopes: JitControlPathScopesMap;
  producedValuesByVarId: ReadonlyMap<number, JitProducedValue>;
  valueTimeline: JitInstructionValueTimeline;
}>;

export type JitCodegenInstructionPlan =
  JitInstructionWithPlannedValues<JitPreparedCodegenInstruction>;

export type JitCodegenEmissionPlan = Readonly<{
  instructions: readonly JitCodegenInstructionPlan[];
  exitPoints: readonly JitExitPoint[];
  materializationNeeds: readonly JitMaterializationNeed[];
  exitMaterializations: readonly JitExitMaterializationPlan[];
  maxExitMaterializationIndex: number;
  plannedValueUses: readonly JitPlannedValueUse[];
  plannedValueCaptures: readonly JitPlannedValueCapture[];
  valueCachePlan: JitExpressionValueCachePlan | undefined;
}>;

export function buildJitCodegenEmissionPlan(codegenPlan: JitCodegenPlan): JitCodegenEmissionPlan {
  const block = codegenPlan.block;

  if (block.instructions.length !== codegenPlan.instructionStates.length) {
    throw new Error(
      `JIT codegen instruction count mismatch: ${block.instructions.length} !== ${codegenPlan.instructionStates.length}`
    );
  }

  const preparedInstructions = prepareJitCodegenInstructions(codegenPlan);
  const plannedValues = planJitValuesForEmission(preparedInstructions, codegenPlan.materializationNeeds);

  return {
    instructions: plannedValues.instructions,
    exitPoints: codegenPlan.exitPoints,
    materializationNeeds: codegenPlan.materializationNeeds,
    exitMaterializations: codegenPlan.exitMaterializations,
    maxExitMaterializationIndex: codegenPlan.maxExitMaterializationIndex,
    plannedValueUses: plannedValues.plannedValueUses,
    plannedValueCaptures: plannedValues.plannedValueCaptures,
    valueCachePlan: plannedValues.valueCachePlan
  };
}

function prepareJitCodegenInstructions(
  codegenPlan: JitCodegenPlan
): readonly JitPreparedCodegenInstruction[] {
  return codegenPlan.block.instructions.map((instruction, index) =>
    prepareJitCodegenInstruction(
      instruction,
      index,
      requiredInstructionState(codegenPlan, index)
    )
  );
}

function prepareJitCodegenInstruction(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  state: JitInstructionState
): JitPreparedCodegenInstruction {
  const expressionPlan = buildIrExpressionBlockWithSourceMap(
    instruction.ir,
    jitExpressionOptions(instruction)
  );
  const producedValuesByVarId = indexProducedValuesByVarIdForInstruction(
    instruction,
    instructionIndex
  );
  const valueTimeline = buildJitInstructionValueTimeline({
    operands: instruction.operands,
    expressionBlock: expressionPlan.expressionBlock,
    entryValueState: state.entryPoint.boundaryState.valueState,
    producedValuesByVarId
  });
  const expressionPathScopes = buildJitExpressionControlPathScopes(
    state.controlPathScopes,
    expressionPlan.sourceMap,
    instructionIndex
  );

  return {
    ...state,
    operands: instruction.operands,
    producedValuesByVarId,
    valueTimeline,
    expressionBlock: expressionPlan.expressionBlock,
    sourceExpressionMap: expressionPlan.sourceMap,
    expressionPathScopes
  };
}

function requiredInstructionState(
  codegenPlan: JitCodegenPlan,
  instructionIndex: number
): JitInstructionState {
  const state = codegenPlan.instructionStates[instructionIndex];

  if (state === undefined) {
    throw new Error(`missing JIT instruction state for codegen: ${instructionIndex}`);
  }

  return state;
}

function jitExpressionOptions(instruction: Pick<JitIrBlockInstruction, "operands">): IrExpressionOptions {
  return {
    canInlineGet: (source) => canInlineJitInstructionGet(instruction, source),
    alias: {
      storageMayAlias: (write, read) => jitInstructionStorageRefsMayAlias(instruction, write, read)
    }
  };
}
