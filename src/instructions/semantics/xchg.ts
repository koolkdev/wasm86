import type { OperandWidth } from "#core/types.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";

export function xchgSemantic(width: OperandWidth = 32): InstructionSemantics {
  return (s) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);

    const leftTarget = s.update(leftOperand, width);
    const rightTarget = s.update(rightOperand, width);
    const left = s.read(leftTarget);
    const right = s.read(rightTarget);

    s.write(rightTarget, left);
    s.write(leftTarget, right);
  };
}
