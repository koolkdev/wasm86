import type {
  SemanticsBuilder,
  SemanticTemplate
} from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import type { OperandWidth } from "#x86/types.js";
import { buildShiftResultAndWriteFlags } from "./alu-flags.js";
import { guardStorageReadWrite } from "./memory.js";

export type ShiftOp = "shl" | "shr" | "sar";
export type ShiftCountSource = "one" | "cl" | "imm8";

export function shiftSemantic(
  op: ShiftOp,
  width: OperandWidth,
  countSource: ShiftCountSource
): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);

    guardStorageReadWrite(s, context, dst, width);

    const value = s.get(dst, width);
    const rawCount = readCount(s, countSource);
    const result = buildShiftResultAndWriteFlags(s, {
      op,
      width,
      value,
      rawCount
    });

    s.set(dst, result, width);
  };
}

function readCount(s: SemanticsBuilder, countSource: ShiftCountSource): Value {
  switch (countSource) {
    case "one":
      return s.const32(1);
    case "cl":
      return s.get(s.reg("cl"), 8);
    case "imm8":
      return s.get(s.operand(1), 8);
  }
}
