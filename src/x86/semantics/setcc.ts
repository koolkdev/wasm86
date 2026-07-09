import type { ConditionCode } from "#x86/conditions.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { guardStorageWrite } from "./memory.js";

export function setccSemantic(cc: ConditionCode): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const condition = s.condition(cc);

    guardStorageWrite(s, v, context, dst, 8);
    s.set(dst, v.select(condition, v.const(1), v.const(0)), 8);
  };
}
