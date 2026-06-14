import type { ConditionCode } from "#x86/conditions.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { guardStorageWrite } from "./memory.js";

export function setccSemantic(cc: ConditionCode): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const condition = s.condition(cc);

    guardStorageWrite(s, context, dst, 8);
    s.set(dst, s.i32Select(condition, s.const32(1), s.const32(0)), 8);
  };
}
