import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type {
  SemanticsBuilder,
  SemanticTemplate
} from "#core/semantics/builder.js";
import type { Value } from "#core/semantics/refs.js";
import type { OperandWidth } from "#core/types.js";
import { writeShiftFlags } from "./flag-writes.js";

export type ShiftOp = "shl" | "shr" | "sar";
export type DoubleShiftOp = "shld" | "shrd";
export type ShiftCountSource = "one" | "cl" | "imm8";
export type DoubleShiftCountSource = Extract<ShiftCountSource, "cl" | "imm8">;

export function shiftSemantic(
  op: ShiftOp,
  width: OperandWidth,
  countSource: ShiftCountSource
): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const destination = s.update(dst, { width });
    const value = v.truncate(width, destination.read(s));
    const rawCount = readShiftCount(s, v, countSource);
    const count = v.binary("and", rawCount, v.const(0x1f));
    const shiftedResult = v.truncate(width, shiftResult(v, op, width, value, count));
    const result = v.select(v.compare(32, "ne", count, v.const(0)), shiftedResult, value);

    writeShiftFlags(s, v, { op, width, value, count, result });
    destination.write(s, result);
  };
}

export function doubleShiftSemantic(
  op: DoubleShiftOp,
  width: Extract<OperandWidth, 16 | 32>,
  countSource: DoubleShiftCountSource
): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const destination = s.update(dst, { width });
    const value = v.truncate(width, destination.read(s));
    const source = v.truncate(width, s.read(src, { width }));
    const rawCount = readDoubleShiftCount(s, countSource);
    const count = v.binary("and", rawCount, v.const(0x1f));
    const shiftedResult = v.truncate(width, doubleShiftResult(v, op, width, value, source, count));
    const result = v.select(v.compare(32, "ne", count, v.const(0)), shiftedResult, value);

    writeShiftFlags(s, v, { op, width, value, count, result });
    destination.write(s, result);
  };
}

export function readShiftCount(s: SemanticsBuilder, v: ValueBuilder, countSource: ShiftCountSource): Value {
  switch (countSource) {
    case "one":
      return v.const(1);
    case "cl":
      return s.read(s.reg("cl"), { width: 8 });
    case "imm8":
      return s.read(s.operand(1), { width: 8 });
  }
}

function readDoubleShiftCount(s: SemanticsBuilder, countSource: DoubleShiftCountSource): Value {
  switch (countSource) {
    case "cl":
      return s.read(s.reg("cl"), { width: 8 });
    case "imm8":
      return s.read(s.operand(2), { width: 8 });
  }
}

function shiftResult(
  v: ValueBuilder,
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
  v: ValueBuilder,
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
  v: ValueBuilder,
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
