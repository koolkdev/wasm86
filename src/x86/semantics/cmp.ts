import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandWidth } from "#x86/types.js";
import { subFlagSource } from "./flag-writes.js";
import { guardStorageRead } from "./memory.js";

export function cmpSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);

    guardStorageRead(s, context, leftOperand, width);
    guardStorageRead(s, context, rightOperand, width);

    const left = s.project(width, s.get(leftOperand, width));
    const right = s.project(width, s.get(rightOperand, width));
    const result = s.project(width, s.binary("sub", left, right));

    s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
  };
}
