import type { ConditionCode, SemanticTemplate } from "#x86/ir/model/types.js";

export function setccSemantic(cc: ConditionCode): SemanticTemplate {
  return (s) => {
    const condition = s.condition(cc);

    s.set(s.operand(0), s.i32Select(condition, 1, 0), 8);
  };
}
