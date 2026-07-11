import type { Values } from "#ir/values.js";
import type {
  SemanticsBuilder,
  SemanticTemplate
} from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import type { OperandWidth } from "#x86/types.js";
import { writeShiftFlags } from "./flag-writes.js";
import { readStorage, resolveStorageReadWrite, writeStorage } from "./memory.js";

export type ShiftOp = "shl" | "shr" | "sar";
export type DoubleShiftOp = "shld" | "shrd";
export type ShiftCountSource = "one" | "cl" | "imm8";
export type DoubleShiftCountSource = Extract<ShiftCountSource, "cl" | "imm8">;

export function shiftSemantic(
  op: ShiftOp,
  width: OperandWidth,
  countSource: ShiftCountSource
): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);

    const dstStorage = resolveStorageReadWrite(s, v, context, dst, width);

    const value = v.truncate(width, readStorage(s, v, dstStorage, width));
    const rawCount = readShiftCount(s, v, countSource);
    const count = v.binary("and", rawCount, v.const(0x1f));
    const shiftedResult = v.truncate(width, shiftResult(v, op, width, value, count));
    const result = v.select(v.compare(32, "ne", count, v.const(0)), shiftedResult, value);

    writeShiftFlags(s, v, { op, width, value, count, result });
    writeStorage(s, v, dstStorage, result, width);
  };
}

export function doubleShiftSemantic(
  op: DoubleShiftOp,
  width: Extract<OperandWidth, 16 | 32>,
  countSource: DoubleShiftCountSource
): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const dstStorage = resolveStorageReadWrite(s, v, context, dst, width);

    const value = v.truncate(width, readStorage(s, v, dstStorage, width));
    const source = v.truncate(width, s.get(src, width));
    const rawCount = readDoubleShiftCount(s, countSource);
    const count = v.binary("and", rawCount, v.const(0x1f));
    const shiftedResult = v.truncate(width, doubleShiftResult(v, op, width, value, source, count));
    const result = v.select(v.compare(32, "ne", count, v.const(0)), shiftedResult, value);

    writeShiftFlags(s, v, { op, width, value, count, result });
    writeStorage(s, v, dstStorage, result, width);
  };
}

export function readShiftCount(s: SemanticsBuilder, v: Values, countSource: ShiftCountSource): Value {
  switch (countSource) {
    case "one":
      return v.const(1);
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
  v: Values,
  op: ShiftOp,
  width: OperandWidth,
  value: Value,
  count: Value
): Value {
  switch (op) {
    case "shl":
      return v.binary("shl", value, count);
    case "shr":
      return v.binary("shr_u", value, count);
    case "sar":
      return v.binary("shr_s", sarShiftInput(v, width, value), count);
  }
}

function doubleShiftResult(
  v: Values,
  op: DoubleShiftOp,
  width: Extract<OperandWidth, 16 | 32>,
  value: Value,
  source: Value,
  count: Value
): Value {
  const backCount = v.binary("sub", v.const(width), count);

  switch (op) {
    case "shld":
      return v.binary(
        "or",
        v.binary("shl", value, count),
        v.binary("shr_u", source, backCount)
      );
    case "shrd":
      return v.binary(
        "or",
        v.binary("shr_u", value, count),
        v.binary("shl", source, backCount)
      );
  }
}

function sarShiftInput(
  v: Values,
  width: OperandWidth,
  value: Value
): Value {
  switch (width) {
    case 8:
      return v.extend(8, value, true);
    case 16:
      return v.extend(16, value, true);
    case 32:
      return value;
  }
}
