import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandWidth } from "#x86/types.js";
import { buildTestFlagSource } from "./alu-flags.js";
import { guardStorageRead } from "./memory.js";

export function testSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);

    guardStorageRead(s, context, leftOperand, width);
    guardStorageRead(s, context, rightOperand, width);

    const left = s.get(leftOperand, width);
    const right = s.get(rightOperand, width);

    s.writeStatusFlagsSource(buildTestFlagSource(s, { width, left, right }));
  };
}
