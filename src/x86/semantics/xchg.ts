import type { OperandWidth } from "#x86/types.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { guardStorageReadWrite } from "./memory.js";

export function xchgSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s, _v, context) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);

    guardStorageReadWrite(s, context, leftOperand, width);
    guardStorageReadWrite(s, context, rightOperand, width);

    const left = s.get(leftOperand, width);
    const right = s.get(rightOperand, width);

    s.set(rightOperand, left, width);
    s.set(leftOperand, right, width);
  };
}
