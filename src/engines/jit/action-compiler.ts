import { staticInstructionLocation } from "#core/instruction/builder.js";
import { staticOperandBinding } from "#core/instruction/static-binding.js";
import { createLegacyInstructionBlock } from "#engines/legacy-instruction-block.js";
import type { IrBlock } from "#ir/block.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";

export function buildIrBlock(instructions: readonly IsaDecodedInstruction[]): IrBlock {
  const builder = createLegacyInstructionBlock({ segmentMode: "flat32" });

  for (const instruction of instructions) {
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
