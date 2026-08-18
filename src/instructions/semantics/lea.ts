import type { InstructionSemantics } from "#instructions/semantics/builder.js";

export function leaSemantic(width: 16 | 32): InstructionSemantics {
  return (s) => {
    s.write(s.operand(0), s.address(s.operand(1)).truncate(width));
  };
}
