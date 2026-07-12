import type { ConditionCode } from "#core/conditions.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { resolveStorageWrite, writeStorage } from "./memory.js";

export function setccSemantic(cc: ConditionCode): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const condition = s.condition(cc);

    const dstStorage = resolveStorageWrite(s, v, context, dst, 8);

    writeStorage(s, v, dstStorage, v.select(condition, v.const(1), v.const(0)), 8);
  };
}
