import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type { JitValue } from "#backends/wasm/jit/ir/values.js";
import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitControlPathScopesMap } from "./control-paths.js";
import type { JitInstructionValueTimeline } from "./value-timeline.js";
import type { JitMaterializationNeed } from "./types.js";
import {
  placeJitValueUseRecordsOnExpressions
} from "./expression-uses.js";
import {
  planJitExpressionValueCacheForInstructions,
  type JitExpressionValueCachePlan
} from "./value-cache.js";
import {
  buildJitPlannedValueUsesForInstructions,
  type JitPlannedValueUse
} from "./value-uses.js";
import {
  groupJitPlannedCapturesByInstructionExpression,
  planJitValueCaptures,
  type JitPlannedValueCapture,
  type JitPlannedValueCapturesByExpression
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
  plannedValueCapturesByExpressionIndex: JitPlannedValueCapturesByExpression;
}>;

export type JitPlannedValuesForEmission<
  TInstruction extends JitValuePlanningInstructionInput
> = Readonly<{
  instructions: readonly JitInstructionWithPlannedValues<TInstruction>[];
  valueCachePlan: JitExpressionValueCachePlan | undefined;
  plannedValueUses: readonly JitPlannedValueUse[];
  plannedValueCaptures: readonly JitPlannedValueCapture[];
}>;

export function planJitValuesForEmission<TInstruction extends JitValuePlanningInstructionInput>(
  instructions: readonly TInstruction[],
  materializationNeeds: readonly JitMaterializationNeed[]
): JitPlannedValuesForEmission<TInstruction> {
  const materializationUsesByExpression = placeJitValueUseRecordsOnExpressions(
    instructions,
    materializationNeeds
  );
  const materializationValuesByExpression =
    valueUseRecordsToValues(materializationUsesByExpression);
  const valueCachePlan = planJitExpressionValueCacheForInstructions(
    instructions.map((instruction, index) => ({
      operands: instruction.operands,
      expressionBlock: instruction.expressionBlock,
      valueTimeline: instruction.valueTimeline,
      materializationJitValueUsesByExpressionIndex:
        materializationValuesByExpression[index] ?? new Map()
    }))
  );
  const plannedValueUses = buildJitPlannedValueUsesForInstructions(
    instructions.map((instruction, index) => ({
      expressionBlock: instruction.expressionBlock,
      valueTimeline: instruction.valueTimeline,
      expressionPathScopes: instruction.expressionPathScopes,
      materializationValueUsesByExpressionIndex:
        materializationUsesByExpression[index] ?? new Map()
    }))
  );
  const plannedValueCaptures = planJitValueCaptures(plannedValueUses, valueCachePlan);
  const plannedValueCapturesByInstructionExpression =
    groupJitPlannedCapturesByInstructionExpression(
      plannedValueCaptures,
      instructions.length
    );
  const plannedInstructions = instructions.map((instruction, index) => ({
    ...instruction,
    plannedValueCapturesByExpressionIndex: requiredPlannedCapturesByExpression(
      plannedValueCapturesByInstructionExpression,
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

function requiredPlannedCapturesByExpression(
  plannedCapturesByInstructionExpression: readonly JitPlannedValueCapturesByExpression[],
  instructionIndex: number
): JitPlannedValueCapturesByExpression {
  const plannedCaptures = plannedCapturesByInstructionExpression[instructionIndex];

  if (plannedCaptures === undefined) {
    throw new Error(`missing planned JIT value captures for instruction ${instructionIndex}`);
  }

  return plannedCaptures;
}

function valueUseRecordsToValues(
  recordsByExpression: readonly ReadonlyMap<number, readonly JitMaterializationNeed[]>[]
): readonly ReadonlyMap<number, readonly JitValue[]>[] {
  return recordsByExpression.map((records) => {
    const values = new Map<number, JitValue[]>();

    for (const [expressionIndex, uses] of records) {
      values.set(expressionIndex, uses.map((use) => use.value));
    }

    return values;
  });
}
