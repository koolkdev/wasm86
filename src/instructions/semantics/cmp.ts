import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import { subFlagSource } from "#core/flags/lazy/sources.js";

export function cmpSemantic(width: OperandWidth = 32): InstructionSemantics {
  return (s) => {
    const left = s.read(s.operand(0), width);
    const right = s.read(s.operand(1), width);
    const result = left.sub(right);

    s.writeStatusFlagsSource(subFlagSource({ left, right, result }));
  };
}
