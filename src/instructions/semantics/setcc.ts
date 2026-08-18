import { select, u8 } from "#compiler/function/values.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";

export function setccSemantic(cc: ConditionCode): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const condition = s.condition(cc);

    s.write(dst, select(condition, u8(1), u8(0)));
  };
}
