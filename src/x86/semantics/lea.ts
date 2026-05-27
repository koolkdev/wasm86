import type { SemanticTemplate } from "#ir/model/types.js";
import type { OperandWidth } from "#x86/types.js";

export function leaSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s) => {
    s.set(s.operand(0), s.address(s.operand(1)), width);
  };
}
