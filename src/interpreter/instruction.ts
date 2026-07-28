import type { ValueId } from "#compiler/ir/values/types.js";
import { valueInstructionLocation } from "#instructions/lowering/builder.js";
import type { InstructionLowerer } from "#instructions/lowering/lowerer.js";
import type { InstructionTerminals } from "#instructions/lowering/terminal.js";
import type { StateAccess } from "#core/state/access.js";
import { buildExit } from "#cpu/exit.js";
import { instructionCountField, instructionLimitField } from "#cpu/instruction-count.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import { instructionLimitExit } from "./exits.js";
import type { DecodedInstruction } from "./decode.js";

export type BuildInterpreterContinuation = (region: RegionBuilder, targetEip: ValueId) => void;

export function buildInterpreterInstruction(
  region: RegionBuilder,
  decoded: DecodedInstruction,
  stateAccess: StateAccess,
  instructionLowerer: InstructionLowerer,
  buildContinuation: BuildInterpreterContinuation
): void {
  const entryState = stateAccess.bind(region);
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
  nextEip: ValueId,
  stateAccess: StateAccess,
  entryCount: ValueId,
  instructionLimit: ValueId,
  buildContinuation: BuildInterpreterContinuation
): void {
  const values = region.values;
  const completedCount = stateAccess.bind(region).readField(instructionCountField);
  const completedDistance = values.binary("sub", completedCount, entryCount);
  const deadlineDistance = values.binary("sub", instructionLimit, entryCount);
  const crossedDeadline = values.compare(32, "ge_u", completedDistance, deadlineDistance);

  // REP remains fused and may cross the deadline by more than the signed
  // modular half-range. Comparing progress from the starting instruction count
  // preserves that overshoot while still stopping at this completion.
  region.if(
    crossedDeadline,
    (expired) => {
      expired.return([buildExit(expired.values, instructionLimitExit())]);
    },
    { hint: "unlikely" }
  );
  buildContinuation(region, nextEip);
}
