import { createIrBlockBuilder, staticInstructionLocation } from "#ir/builder.js";
import {
  immBinding,
  memBinding,
  regBinding,
  segmentBinding,
  staticMemSegment,
  type OperandBinding
} from "#ir/operands.js";
import { defaultSegmentForBase } from "#x86/segments.js";
import type { IrBlock } from "#ir/block.js";
import type { IsaDecodedInstruction, IsaOperandBinding } from "#x86/decoder/types.js";

export function buildIrBlock(instructions: readonly IsaDecodedInstruction[]): IrBlock {
  const builder = createIrBlockBuilder({ segmentMode: "flat32" });

  for (const instruction of instructions) {
    builder.addInstruction(
      instruction.spec.semantics,
      instruction.operands.map(staticBinding),
      staticInstructionLocation(instruction.address, instruction.nextEip)
    );

    if (builder.isTerminated()) {
      break;
    }
  }

  return builder.finish();
}

function staticBinding(operand: IsaOperandBinding): OperandBinding {
  switch (operand.kind) {
    case "reg":
      return regBinding(operand.alias.name);
    case "segment":
      return segmentBinding(operand.reg);
    case "imm":
      // The decoder already applied the immediate's extension.
      return immBinding(operand.value);
    case "relTarget":
      // The decoder already resolved the absolute target.
      return immBinding(operand.target);
    case "mem":
      return memBinding({
        base: operand.base,
        index: operand.index,
        scale: operand.scale,
        disp: operand.disp
      }, staticMemSegment(operand.segment ?? defaultSegmentForBase(operand.base)));
  }
}
