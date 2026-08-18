import type { I32Value } from "#compiler/function/values.js";
import { valueInstructionLocation } from "#instructions/lowering/builder.js";
import type { InstructionLowerer } from "#instructions/lowering/lowerer.js";
import type { InstructionTerminals } from "#instructions/lowering/terminal.js";
import type { StateAccess } from "#core/state/access.js";
import { buildExit } from "#cpu/exit.js";
import { instructionCountField, instructionLimitField } from "#cpu/instruction-count.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import { instructionLimitExit } from "./exits.js";
import type { DecodedInstruction } from "./decode.js";

export type BuildInterpreterContinuation = (region: RegionBuilder, targetEip: I32Value) => void;

export function buildInterpreterInstruction(
  region: RegionBuilder,
  decoded: DecodedInstruction,
  stateAccess: StateAccess,
  instructionLowerer: InstructionLowerer,
  buildContinuation: BuildInterpreterContinuation
): void {
  const entryState = stateAccess.forRegion(region);
  const entryCount = entryState.readField(instructionCountField);
  const instructionLimit = entryState.readField(instructionLimitField);
  const nextEip = instructionLowerer.lower(
    region,
    interpreterTerminals(buildContinuation),
    (builder) => {
      builder.add(
        decoded.instruction.semantics,
        decoded.bindings,
        valueInstructionLocation(decoded.instructionStart, decoded.nextEip)
      );
    }
  );

  if (nextEip !== undefined) {
    continueInterpreter(
      region,
      nextEip,
      stateAccess,
      entryCount,
      instructionLimit,
      buildContinuation
    );
  }
}

function interpreterTerminals(
  buildContinuation: BuildInterpreterContinuation
): InstructionTerminals {
  return {
    dispatch: buildContinuation,
    returnExit: (region, result) => {
      region.return([result]);
    }
  };
}

function continueInterpreter(
  region: RegionBuilder,
  nextEip: I32Value,
  stateAccess: StateAccess,
  entryCount: I32Value,
  instructionLimit: I32Value,
  buildContinuation: BuildInterpreterContinuation
): void {
  const completedCount = stateAccess.forRegion(region).readField(instructionCountField);
  const completedDistance = completedCount.sub(entryCount);
  const deadlineDistance = instructionLimit.sub(entryCount);
  const crossedDeadline = completedDistance.unsigned.ge(deadlineDistance);

  // REP remains fused and may cross the deadline by more than the signed
  // modular half-range. Comparing progress from the starting instruction count
  // preserves that overshoot while still stopping at this completion.
  region.if(
    crossedDeadline,
    (expired) => {
      expired.return([buildExit(instructionLimitExit())]);
    },
    { hint: "unlikely" }
  );
  buildContinuation(region, nextEip);
}
