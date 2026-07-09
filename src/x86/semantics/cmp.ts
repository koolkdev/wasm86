import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandWidth } from "#x86/types.js";
import { subFlagSource } from "./flag-writes.js";
import { guardStorageRead } from "./memory.js";

export function cmpSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);

    guardStorageRead(s, v, context, leftOperand, width);
    guardStorageRead(s, v, context, rightOperand, width);

    const left = v.truncate(width, s.get(leftOperand, width));
    const right = v.truncate(width, s.get(rightOperand, width));
    const result = v.truncate(width, v.binary("sub", left, right));

    s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
  };
}
