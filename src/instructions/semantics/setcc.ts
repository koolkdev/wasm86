import type { ConditionCode } from "#core/flags/conditions.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";

export function setccSemantic(cc: ConditionCode): InstructionSemantics {
  return (s, v) => {
    const dst = s.operand(0);
    const condition = s.condition(cc);

    s.write(dst, v.select(condition, v.const(1), v.const(0)), { width: 8 });
  };
}
