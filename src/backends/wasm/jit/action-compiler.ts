import { createActionBuilder } from "#ir/action/builder.js";
import { immBinding, memBinding, regBinding, type OperandBinding } from "#ir/action/operands.js";
import type { ActionBlock } from "#ir/action/types.js";
import type { IsaDecodedInstruction, IsaOperandBinding } from "#x86/decoder/types.js";

export function buildActionBlock(instructions: readonly IsaDecodedInstruction[]): ActionBlock {
  const builder = createActionBuilder();

  for (const instruction of instructions) {
    builder.addInstruction(instruction.spec.semantics, instruction.operands.map(staticBinding), {
      eip: instruction.address,
      nextEip: instruction.nextEip
    });
  }

  return builder.finish();
}

function staticBinding(operand: IsaOperandBinding): OperandBinding {
  switch (operand.kind) {
    case "reg":
      return regBinding(operand.alias.name);
    case "imm":
      // The decoder already applied the immediate's extension.
      return immBinding(operand.value);
    case "relTarget":
      // The decoder already resolved the absolute target.
      return immBinding(operand.target);
    case "mem":
      return memBinding({
        ...(operand.base === undefined ? {} : { base: operand.base }),
        ...(operand.index === undefined ? {} : { index: operand.index }),
        scale: operand.scale,
        disp: operand.disp
      });
  }
}
