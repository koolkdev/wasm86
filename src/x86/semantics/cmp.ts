import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import { subFlagSource } from "./flag-writes.js";
import { readStorage, resolveStorageRead } from "./memory.js";

export function cmpSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);

    const leftStorage = resolveStorageRead(s, v, context, leftOperand, width);
    const rightStorage = resolveStorageRead(s, v, context, rightOperand, width);

    const left = v.truncate(width, readStorage(s, v, leftStorage, width));
    const right = v.truncate(width, readStorage(s, v, rightStorage, width));
    const result = v.truncate(width, v.binary("sub", left, right));

    s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
  };
}
