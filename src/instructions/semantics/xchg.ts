import type { OperandWidth } from "#core/types.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";

export function xchgSemantic(width: OperandWidth = 32): InstructionSemantics {
  return (s) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);

    const leftTarget = s.update(leftOperand, { width });
    const rightTarget = s.update(rightOperand, { width });
    const left = leftTarget.read(s);
    const right = rightTarget.read(s);

    rightTarget.write(s, left);
    leftTarget.write(s, right);
  };
}
