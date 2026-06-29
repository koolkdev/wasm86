import type {
  SemanticsBuilder,
  SemanticTemplate
} from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import type { OperandWidth } from "#x86/types.js";
import { writeShiftFlags } from "./flag-writes.js";
import { guardStorageReadWrite } from "./memory.js";

export type ShiftOp = "shl" | "shr" | "sar";
export type DoubleShiftOp = "shld" | "shrd";
export type ShiftCountSource = "one" | "cl" | "imm8";
export type DoubleShiftCountSource = Extract<ShiftCountSource, "cl" | "imm8">;

export function shiftSemantic(
  op: ShiftOp,
  width: OperandWidth,
  countSource: ShiftCountSource
): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);

    guardStorageReadWrite(s, context, dst, width);

    const value = s.truncate(width, s.get(dst, width));
    const rawCount = readShiftCount(s, countSource);
    const count = s.binary("and", rawCount, s.const32(0x1f));
    const shiftedResult = s.truncate(width, shiftResult(s, op, width, value, count));
    const result = s.select(s.compare(32, "ne", count, s.const32(0)), shiftedResult, value);

    writeShiftFlags(s, { op, width, value, count, result });
    s.set(dst, result, width);
  };
}

export function doubleShiftSemantic(
  op: DoubleShiftOp,
  width: Extract<OperandWidth, 16 | 32>,
  countSource: DoubleShiftCountSource
): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageReadWrite(s, context, dst, width);

    const value = s.truncate(width, s.get(dst, width));
    const source = s.truncate(width, s.get(src, width));
    const rawCount = readDoubleShiftCount(s, countSource);
    const count = s.binary("and", rawCount, s.const32(0x1f));
    const shiftedResult = s.truncate(width, doubleShiftResult(s, op, width, value, source, count));
    const result = s.select(s.compare(32, "ne", count, s.const32(0)), shiftedResult, value);

    writeShiftFlags(s, { op, width, value, count, result });
    s.set(dst, result, width);
  };
}

export function readShiftCount(s: SemanticsBuilder, countSource: ShiftCountSource): Value {
  switch (countSource) {
    case "one":
      return s.const32(1);
    case "cl":
      return s.get(s.reg("cl"), 8);
    case "imm8":
      return s.get(s.operand(1), 8);
  }
}

function readDoubleShiftCount(s: SemanticsBuilder, countSource: DoubleShiftCountSource): Value {
  switch (countSource) {
    case "cl":
      return s.get(s.reg("cl"), 8);
    case "imm8":
      return s.get(s.operand(2), 8);
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

function doubleShiftResult(
  s: SemanticsBuilder,
  op: DoubleShiftOp,
  width: Extract<OperandWidth, 16 | 32>,
  value: Value,
  source: Value,
  count: Value
): Value {
  const backCount = s.binary("sub", s.const32(width), count);

  switch (op) {
    case "shld":
      return s.binary(
        "or",
        s.binary("shl", value, count),
        s.binary("shr_u", source, backCount)
      );
    case "shrd":
      return s.binary(
        "or",
        s.binary("shr_u", value, count),
        s.binary("shl", source, backCount)
      );
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
