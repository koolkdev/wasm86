import type { OperandWidth } from "#core/types.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import { readStorage, resolveStorageReadWrite, writeStorage } from "./memory.js";

export function xchgSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);

    const leftStorage = resolveStorageReadWrite(s, v, context, leftOperand, width);
    const rightStorage = resolveStorageReadWrite(s, v, context, rightOperand, width);

    const left = readStorage(s, v, leftStorage, width);
    const right = readStorage(s, v, rightStorage, width);

    writeStorage(s, v, rightStorage, left, width);
    writeStorage(s, v, leftStorage, right, width);
  };
}
