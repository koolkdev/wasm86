import type { SemanticTemplate } from "#core/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";

export function leaSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s) => {
    s.set(s.operand(0), s.address(s.operand(1)), width);
  };
}
