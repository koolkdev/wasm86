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
import type {
  PlannedExit,
  PlannedInstruction
} from "./types.js";

export type InstructionWithReusePlan<
  TInstruction extends PlannedInstruction
> = TInstruction & Readonly<{
  captureMap: InstructionCaptureMap;
}>;

export type PlannedReuseForEmission<
  TInstruction extends PlannedInstruction
> = Readonly<{
  instructions: readonly InstructionWithReusePlan<TInstruction>[];
  valueUses: readonly ValueUse[];
  reusePlan: InstructionReusePlan;
}>;

export function planReuseForEmission<TInstruction extends PlannedInstruction>(
  instructions: readonly TInstruction[],
  valueUses: readonly ValueUse[],
  exits: readonly PlannedExit[]
): PlannedReuseForEmission<TInstruction> {
  const reuseInputs = instructions.map((instruction) => ({
    operands: instruction.analysis.instruction.operands,
    expressionBlock: instruction.analysis.expressions,
    valueTimeline: instruction.analysis.timeline
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
