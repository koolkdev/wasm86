import {
  staticInstructionLocation,
  type InstructionConstruction
} from "#core/instruction/builder.js";
import { staticOperandBinding } from "#core/instruction/static-binding.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import { createLegacyInstructionBlock } from "#engines/legacy-instruction-block.js";
import type { IrBlock } from "#ir/block.js";
import type {
  IsaDecodedInstruction,
  IsaDecodeExceptionResult
} from "#core/decoder/types.js";
import {
  mapCpuException,
  type CpuException
} from "#core/exceptions.js";

export function buildIrBlock(
  construction: InstructionConstruction,
  decodedInstructions: readonly IsaDecodedInstruction[],
  decodeException?: IsaDecodeExceptionResult
): IrBlock {
  const builder = createLegacyInstructionBlock(construction);
  let continues = true;

  for (const instruction of decodedInstructions) {
    continues = builder.add(
      instruction.spec.semantics,
      instruction.operands.map(staticOperandBinding),
      staticInstructionLocation(instruction.address, instruction.nextEip)
    );

    if (!continues) {
      break;
    }
  }

  if (continues && decodeException !== undefined) {
    builder.add(
      cpuExceptionSemantic(decodeException.exception),
      [],
      staticInstructionLocation(
        decodeException.instructionStart,
        decodeException.instructionStart
      )
    );
  }

  return builder.finish();
}

function cpuExceptionSemantic(exception: CpuException<number>): SemanticTemplate {
  return (semantics, values) => semantics.cpuException(
    mapCpuException(exception, (value) => values.const(value))
  );
}
