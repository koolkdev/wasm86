import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { FieldRef } from "#compiler/layout/handles.js";
import { createStatusFlagResolvers } from "#core/flags/lazy/resolvers.js";
import type { StateAccess } from "#core/state/access.js";
import type { MemoryAccess } from "#memory/types.js";
import {
  buildInstructionSequence,
  type InstructionBuilder
} from "./builder.js";
import type {
  BuildExit,
  InstructionTerminals
} from "./terminal.js";

export type InstructionLowerer = Readonly<{
  lower(
    region: RegionBuilder,
    terminals: InstructionTerminals,
    addInstructions: (builder: InstructionBuilder) => void
  ): ValueId | undefined;
}>;

export type InstructionLowererOptions = Readonly<{
  stateAccess: StateAccess;
  memory: MemoryAccess;
  instructionCountField: FieldRef<"u32">;
  buildExit: BuildExit;
}>;

// One lowerer shares its generated status-flag resolver family across every
// instruction body without exposing that family to Interpreter or JIT.
export function createInstructionLowerer(
  options: InstructionLowererOptions
): InstructionLowerer {
  const statusFlagResolvers = createStatusFlagResolvers(options.stateAccess);

  return {
    lower: (region, terminals, addInstructions) =>
      buildInstructionSequence(
        region,
        {
          ...options,
          statusFlagResolvers,
          terminals
        },
        addInstructions
      )
  };
}
