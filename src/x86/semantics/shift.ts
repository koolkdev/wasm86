import type {
  SemanticsBuilder,
  SemanticTemplate
} from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import type { OperandWidth } from "#x86/types.js";
import { writeShiftFlags } from "./flag-writes.js";
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

    const value = s.project(width, s.get(dst, width));
    const rawCount = readCount(s, countSource);
    const count = s.binary("and", rawCount, s.const32(0x1f));
    const shiftedResult = s.project(width, shiftResult(s, op, width, value, count));
    const result = s.select(s.compare(32, "ne", count, s.const32(0)), shiftedResult, value);

    writeShiftFlags(s, { op, width, value, count, result });
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

function shiftResult(
  s: SemanticsBuilder,
  op: ShiftOp,
  width: OperandWidth,
  value: Value,
  count: Value
): Value {
  switch (op) {
    case "shl":
      return s.binary("shl", value, count);
    case "shr":
      return s.binary("shr_u", value, count);
    case "sar":
      return s.binary("shr_s", sarShiftInput(s, width, value), count);
  }
}

function sarShiftInput(
  s: SemanticsBuilder,
  width: OperandWidth,
  value: Value
): Value {
  switch (width) {
    case 8:
      return s.extend(8, value, true);
    case 16:
      return s.extend(16, value, true);
    case 32:
      return value;
  }
}
