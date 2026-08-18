import { i32, select, u8, type Integer } from "#compiler/function/values.js";
import type { SemanticsBuilder, InstructionSemantics } from "#instructions/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import { writeShiftFlags } from "./flag-writes.js";

export type ShiftOp = "shl" | "shr" | "sar";
export type DoubleShiftOp = "shld" | "shrd";
export type ShiftCountSource = "one" | "cl" | "imm8";
export type DoubleShiftCountSource = Extract<ShiftCountSource, "cl" | "imm8">;

export function shiftSemantic<Width extends OperandWidth>(
  op: ShiftOp,
  width: Width,
  countSource: ShiftCountSource
): InstructionSemantics {
  return (s) => {
    const destination = s.update(s.operand(0), width);
    const value = s.read(destination);
    const count = readShiftCount(s, countSource).and(0x1f);
    const shiftedResult = shiftResult(op, value, count);
    const result = select(count.ne(0), shiftedResult, value);

    writeShiftFlags(s, { op, value, count, result });
    s.write(destination, result);
  };
}

export function doubleShiftSemantic<Width extends Extract<OperandWidth, 16 | 32>>(
  op: DoubleShiftOp,
  width: Width,
  countSource: DoubleShiftCountSource
): InstructionSemantics {
  return (s) => {
    const destination = s.update(s.operand(0), width);
    const value = s.read(destination);
    const source = s.read(s.operand(1), width);
    const count = readShiftCount(s, countSource, 2).and(0x1f);
    const shiftedResult = doubleShiftResult(op, value, source, count);
    const result = select(count.ne(0), shiftedResult, value);

    writeShiftFlags(s, { op, value, count, result });
    s.write(destination, result);
  };
}

export function readShiftCount(
  s: SemanticsBuilder,
  countSource: ShiftCountSource,
  immediateOperand = 1
): Integer<8> {
  switch (countSource) {
    case "one":
      return u8(1);
    case "cl":
      return s.read(s.reg("cl"));
    case "imm8":
      return s.read(s.operand(immediateOperand), 8);
  }
}

function shiftResult<Width extends OperandWidth>(
  op: ShiftOp,
  value: Integer<Width>,
  count: Integer<8>
): Integer<Width> {
  switch (op) {
    case "shl":
      return value.shl(count);
    case "shr":
      return value.unsigned.shr(count);
    case "sar":
      return value.signed.shr(count);
  }
}

function doubleShiftResult<Width extends Extract<OperandWidth, 16 | 32>>(
  op: DoubleShiftOp,
  value: Integer<Width>,
  source: Integer<NoInfer<Width>>,
  count: Integer<8>
): Integer<Width> {
  const backCount = i32(value.width).sub(count.unsigned.extend(32));
  const extendedValue = value.unsigned.extend(32);
  const extendedSource = source.unsigned.extend(32);
  const shifted =
    op === "shld"
      ? extendedValue.shl(count).or(extendedSource.unsigned.shr(backCount))
      : extendedValue.unsigned.shr(count).or(extendedSource.shl(backCount));

  return shifted.truncate(value.width);
}
