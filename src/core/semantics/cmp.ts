import type { SemanticTemplate } from "#core/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import { subFlagSource } from "#core/flags/lazy/sources.js";

export function cmpSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s, v) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);
    const left = v.truncate(width, s.read(leftOperand, { width }));
    const right = v.truncate(width, s.read(rightOperand, { width }));
    const result = v.truncate(width, v.binary("sub", left, right));

    s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
  };
}
