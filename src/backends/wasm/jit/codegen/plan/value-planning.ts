import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { PathMap } from "#backends/wasm/jit/analysis/paths.js";
import type { Timeline } from "#backends/wasm/jit/analysis/timeline.js";
import {
  planReuseForInstructions,
  type InstructionCaptureMap,
  type InstructionReusePlan
} from "./reuse.js";
import {
  type ValueUse
} from "./value-uses.js";
import {
  groupCapturesByInstruction
} from "./captures.js";
import type { PlannedExit } from "./types.js";

export type ReusePlanningInstructionInput = Readonly<{
  operands: readonly JitOperandBinding[];
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
  expressionPaths: PathMap;
  valueTimeline: Timeline;
}>;

export type InstructionWithReusePlan<
  TInstruction extends ReusePlanningInstructionInput
> = TInstruction & Readonly<{
  captureMap: InstructionCaptureMap;
}>;

export type PlannedReuseForEmission<
  TInstruction extends ReusePlanningInstructionInput
> = Readonly<{
  instructions: readonly InstructionWithReusePlan<TInstruction>[];
  valueUses: readonly ValueUse[];
  reusePlan: InstructionReusePlan;
}>;

export function planReuseForEmission<TInstruction extends ReusePlanningInstructionInput>(
  instructions: readonly TInstruction[],
  valueUses: readonly ValueUse[],
  exits: readonly PlannedExit[]
): PlannedReuseForEmission<TInstruction> {
  const reuseInputs = instructions.map((instruction) => ({
    operands: instruction.operands,
    expressionBlock: instruction.expressionBlock,
    valueTimeline: instruction.valueTimeline
  }));
  const reusePlan = planReuseForInstructions(
    reuseInputs,
    valueUses,
    exits
  );
  const captureMaps = groupCapturesByInstruction(
    reusePlan.captures.captures,
    instructions.length
  );
  const plannedInstructions = instructions.map((instruction, index) => ({
    ...instruction,
    captureMap: requiredCaptureMap(
      captureMaps,
      index
    )
  }));

  return {
    instructions: plannedInstructions,
    valueUses,
    reusePlan
  };
}

function requiredCaptureMap(
  instructionCaptureMaps: readonly InstructionCaptureMap[],
  instructionIndex: number
): InstructionCaptureMap {
  const plannedCaptures = instructionCaptureMaps[instructionIndex];

  if (plannedCaptures === undefined) {
    throw new Error(`missing planned JIT value captures for instruction ${instructionIndex}`);
  }

  return plannedCaptures;
}
