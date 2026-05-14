import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitControlPathScopesMap } from "./control-paths.js";
import type { JitInstructionValueTimeline } from "./value-timeline.js";
import {
  planJitValueCacheForInstructions,
  type JitValueCachePlan
} from "./value-cache.js";
import {
  type JitPlannedValueUse
} from "./value-uses.js";
import {
  groupJitPlannedCaptures,
  planJitValueCaptures,
  type JitPlannedValueCapture,
  type JitExpressionCaptureMap
} from "./value-captures.js";

export type JitValuePlanningInstructionInput = Readonly<{
  operands: readonly JitOperandBinding[];
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
  expressionPathScopes: JitControlPathScopesMap;
  valueTimeline: JitInstructionValueTimeline;
}>;

export type JitInstructionWithPlannedValues<
  TInstruction extends JitValuePlanningInstructionInput
> = TInstruction & Readonly<{
  plannedValueCaptures: JitExpressionCaptureMap;
}>;

export type JitPlannedValuesForEmission<
  TInstruction extends JitValuePlanningInstructionInput
> = Readonly<{
  instructions: readonly JitInstructionWithPlannedValues<TInstruction>[];
  valueCachePlan: JitValueCachePlan;
  plannedValueUses: readonly JitPlannedValueUse[];
  plannedValueCaptures: readonly JitPlannedValueCapture[];
}>;

export function planJitValuesForEmission<TInstruction extends JitValuePlanningInstructionInput>(
  instructions: readonly TInstruction[],
  plannedValueUses: readonly JitPlannedValueUse[]
): JitPlannedValuesForEmission<TInstruction> {
  const cacheInputs = instructions.map((instruction) => ({
    operands: instruction.operands,
    expressionBlock: instruction.expressionBlock,
    valueTimeline: instruction.valueTimeline
  }));
  const valueCachePlan = planJitValueCacheForInstructions(
    cacheInputs,
    plannedValueUses
  );
  const plannedValueCaptures = planJitValueCaptures(plannedValueUses, valueCachePlan);
  const captureMaps = groupJitPlannedCaptures(
    plannedValueCaptures,
    instructions.length
  );
  const plannedInstructions = instructions.map((instruction, index) => ({
    ...instruction,
    plannedValueCaptures: requiredCaptureMap(
      captureMaps,
      index
    )
  }));

  return {
    instructions: plannedInstructions,
    valueCachePlan,
    plannedValueUses,
    plannedValueCaptures
  };
}

function requiredCaptureMap(
  instructionCaptureMaps: readonly JitExpressionCaptureMap[],
  instructionIndex: number
): JitExpressionCaptureMap {
  const plannedCaptures = instructionCaptureMaps[instructionIndex];

  if (plannedCaptures === undefined) {
    throw new Error(`missing planned JIT value captures for instruction ${instructionIndex}`);
  }

  return plannedCaptures;
}
