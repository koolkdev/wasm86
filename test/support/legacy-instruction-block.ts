import {
  createLegacyInstructionBlock as createEngineLegacyInstructionBlock,
  type LegacyInstructionBlock
} from "#engines/legacy-instruction-block.js";
import { testInstructionConstruction } from "./execution-model.js";

export type { LegacyInstructionBlock };

export function createLegacyInstructionBlock(): LegacyInstructionBlock {
  return createEngineLegacyInstructionBlock(
    testInstructionConstruction
  );
}
