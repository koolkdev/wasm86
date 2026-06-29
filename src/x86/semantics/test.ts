import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandWidth } from "#x86/types.js";
import { logicFlagSource } from "./flag-writes.js";
import { guardStorageRead } from "./memory.js";

export function testSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);

    guardStorageRead(s, context, leftOperand, width);
    guardStorageRead(s, context, rightOperand, width);

    const left = s.truncate(width, s.get(leftOperand, width));
    const right = s.truncate(width, s.get(rightOperand, width));
    const result = s.truncate(width, s.binary("and", left, right));

    s.writeStatusFlagsSource(logicFlagSource({ width, result }));
  };
}
