import {
  staticInstructionLocation,
  type InstructionConstruction
} from "#core/instruction/builder.js";
import { staticOperandBinding } from "#core/instruction/static-binding.js";
import { createLegacyInstructionBlock } from "#engines/legacy-instruction-block.js";
import type { IrBlock } from "#ir/block.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";

export function buildIrBlock(
  construction: InstructionConstruction,
  decodedInstructions: readonly IsaDecodedInstruction[]
): IrBlock {
  const builder = createLegacyInstructionBlock(construction);

  for (const instruction of decodedInstructions) {
    const continues = builder.add(
      instruction.spec.semantics,
      instruction.operands.map(staticOperandBinding),
      staticInstructionLocation(instruction.address, instruction.nextEip)
    );

    if (!continues) {
      break;
    }
  }

  return builder.finish();
}
