import type { ConditionCode, SemanticTemplate } from "#ir/model/types.js";
import { guardStorageWrite } from "./memory.js";

export function setccSemantic(cc: ConditionCode): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const condition = s.condition(cc);

    guardStorageWrite(s, context, dst, 8);
    s.set(dst, s.i32Select(condition, 1, 0), 8);
  };
}
