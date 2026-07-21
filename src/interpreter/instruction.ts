import type { ValueId } from "#compiler/ir/values/types.js";
import {
  type InstructionConstruction,
  valueInstructionLocation
} from "#core/instruction/builder.js";
import type { InstructionTerminals } from "#core/instruction/terminal.js";
import type { StateAccess } from "#core/state/access.js";
import { buildExit } from "#cpu/exit.js";
import {
  instructionCountField,
  instructionLimitField
} from "#cpu/instruction-count.js";
import type { RegionBuilder } from "#ir/region-builder.js";
import { instructionLimitExit } from "./exits.js";
import type { DecodedInstruction } from "./decode.js";

export function buildInterpreterInstruction(
  region: RegionBuilder,
  decoded: DecodedInstruction,
  stateAccess: StateAccess,
  instructionConstruction: InstructionConstruction
): void {
  const entryState = stateAccess.bind(region);
  const entryCount = entryState.readField(instructionCountField);
  const instructionLimit = entryState.readField(instructionLimitField);
  const builder = instructionConstruction.createBuilder(
    region,
    interpreterTerminals()
  );

  builder.add(
    decoded.instruction.semantics,
    decoded.bindings,
    valueInstructionLocation(decoded.instructionStart, decoded.nextEip)
  );
  const nextEip = builder.finish();

  if (nextEip !== undefined) {
    continueInterpreter(
      region,
      nextEip,
      stateAccess,
      entryCount,
      instructionLimit
    );
  }
}

function interpreterTerminals(): InstructionTerminals {
  return {
    dispatch: (region, targetEip) => {
      region.loopContinue([targetEip]);
    },
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
  instructionLimit: ValueId
): void {
  const values = region.values;
  const completedCount = stateAccess.bind(region).readField(
    instructionCountField
  );
  const completedDistance = values.binary("sub", completedCount, entryCount);
  const deadlineDistance = values.binary("sub", instructionLimit, entryCount);
  const crossedDeadline = values.compare(
    32,
    "ge_u",
    completedDistance,
    deadlineDistance
  );

  // REP remains fused and may cross the deadline by more than the signed
  // modular half-range. Comparing progress from the admitted entry count
  // preserves that overshoot while still stopping at this completion.
  region.if(crossedDeadline, (expired) => {
    expired.return([
      buildExit(expired.values, instructionLimitExit())
    ]);
  }, { hint: "unlikely" });
  region.loopContinue([nextEip]);
}
