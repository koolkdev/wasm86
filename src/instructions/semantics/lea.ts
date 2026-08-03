import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";

export function leaSemantic(width: OperandWidth = 32): InstructionSemantics {
  return (s) => {
    s.write(s.operand(0), s.address(s.operand(1)), { width });
  };
}
