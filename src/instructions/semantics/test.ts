import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import { logicFlagSource } from "#core/flags/lazy/sources.js";

export function testSemantic(width: OperandWidth = 32): InstructionSemantics {
  return (s) => {
    const left = s.read(s.operand(0), width);
    const right = s.read(s.operand(1), width);
    const result = left.and(right);

    s.writeStatusFlagsSource(logicFlagSource({ result }));
  };
}
