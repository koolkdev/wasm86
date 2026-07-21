import type { ValueId } from "#compiler/ir/values/types.js";
import {
  createInstructionBuilder,
  valueInstructionLocation
} from "#core/instruction/builder.js";
import type { InstructionTerminals } from "#core/instruction/terminal.js";
import type { RegionBuilder } from "#ir/region-builder.js";
import { instructionLimitExit } from "./exits.js";
import type { DecodedInstruction } from "./decode.js";
import type { InterpreterExecutionContext } from "./environment.js";

export function buildInterpreterInstruction(
  region: RegionBuilder,
  decoded: DecodedInstruction,
  context: InterpreterExecutionContext
): void {
  const entryState = context.stateAccess.bind(region);
  const entryCount = entryState.readField(context.instructionCount);
  const instructionLimit = entryState.readField(context.instructionLimit);
  const builder = createInstructionBuilder(region, {
    stateAccess: context.stateAccess,
    statusFlagResolvers: context.statusFlagResolvers,
    memory: context.memory,
    instructionCountField: context.instructionCount,
    buildExit: context.buildExit,
    segmentMode: "flat32",
    terminals: interpreterTerminals()
  });

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
      context,
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
  context: InterpreterExecutionContext,
  entryCount: ValueId,
  instructionLimit: ValueId
): void {
  const values = region.values;
  const completedCount = context.stateAccess.bind(region).readField(
    context.instructionCount
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
      context.buildExit(expired.values, instructionLimitExit())
    ]);
  }, { hint: "unlikely" });
  region.loopContinue([nextEip]);
}
