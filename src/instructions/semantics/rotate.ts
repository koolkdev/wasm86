import { i32, select, type Integer, type BitValue } from "#compiler/function/values.js";
import type {
  SemanticsBuilder,
  SemanticUpdate,
  InstructionSemantics
} from "#instructions/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import { writeRotateFlags } from "./flag-writes.js";
import { readShiftCount, type ShiftCountSource } from "./shift.js";

export type RotateOp = "rol" | "ror" | "rcl" | "rcr";
type PlainRotateOp = Extract<RotateOp, "rol" | "ror">;
type CarryRotateOp = Extract<RotateOp, "rcl" | "rcr">;

type RotateResult<Width extends OperandWidth> = Readonly<{
  result: Integer<Width>;
  carry: BitValue;
}>;

type CarryRotateOperation<Width extends OperandWidth> = (
  op: CarryRotateOp,
  value: Integer<Width>,
  carry: BitValue,
  count: Integer<8>
) => RotateResult<Width>;

export function rotateSemantic(
  op: RotateOp,
  width: OperandWidth,
  countSource: ShiftCountSource
): InstructionSemantics {
  switch (width) {
    case 8:
      return rotateTemplate(op, width, countSource, rotateThroughCarryI32);
    case 16:
      return rotateTemplate(op, width, countSource, rotateThroughCarryI32);
    case 32:
      return rotateTemplate(op, width, countSource, rotateThroughCarryI64);
  }
}

function rotateTemplate<Width extends OperandWidth>(
  op: RotateOp,
  width: Width,
  countSource: ShiftCountSource,
  rotateThroughCarry: CarryRotateOperation<Width>
): InstructionSemantics {
  return (s) => {
    const destination = s.update(s.operand(0), width);
    const value = s.read(destination);
    const count = readShiftCount(s, countSource).and(0x1f);

    if (op === "rol" || op === "ror") {
      writePlainRotate(s, op, value, count, destination);
      return;
    }

    writeCarryRotate(s, op, value, count, destination, rotateThroughCarry);
  };
}

function writePlainRotate<Width extends OperandWidth>(
  s: SemanticsBuilder,
  op: PlainRotateOp,
  value: Integer<Width>,
  count: Integer<8>,
  destination: SemanticUpdate<Width>
): void {
  const result = op === "rol" ? value.rotl(count) : value.rotr(count);
  const carry = op === "rol" ? result.bit(0) : result.msb();

  writeRotateFlags(s, {
    op,
    count,
    result,
    carry,
    carryDefined: count.ne(0)
  });
  s.write(destination, result);
}

function writeCarryRotate<Width extends OperandWidth>(
  s: SemanticsBuilder,
  op: CarryRotateOp,
  value: Integer<Width>,
  count: Integer<8>,
  destination: SemanticUpdate<Width>,
  rotateThroughCarry: CarryRotateOperation<Width>
): void {
  const oldCf = s.readFlag("CF");
  const effective = throughCarryCount(value.width, count);
  const effectiveNonZero = effective.ne(0);
  const rotated = rotateThroughCarry(op, value, oldCf, effective);
  const result = select(effectiveNonZero, rotated.result, value);
  const carry = select(effectiveNonZero, rotated.carry, oldCf);

  writeRotateFlags(s, {
    op,
    count,
    result,
    carry,
    carryDefined: effectiveNonZero,
    oldCf
  });
  s.write(destination, result);
}

function rotateRing<WorkingWidth extends 32 | 64>(
  op: CarryRotateOp,
  ringWidth: number,
  value: Integer<WorkingWidth>,
  count: Integer<8>
): Integer<WorkingWidth> {
  const backCount = i32(ringWidth).sub(count.unsigned.extend(32));

  return op === "rcl"
    ? value.shl(count).or(value.unsigned.shr(backCount))
    : value.unsigned.shr(count).or(value.shl(backCount));
}

function rotateThroughCarryI32<Width extends 8 | 16>(
  op: CarryRotateOp,
  value: Integer<Width>,
  carry: BitValue,
  count: Integer<8>
): RotateResult<Width> {
  const width = value.width;
  const ring = value.unsigned.extend(32).or(carry.unsigned.extend(32).shl(width));
  const rotated = rotateRing(op, width + 1, ring, count);

  return {
    result: rotated.truncate(width),
    carry: rotated.bit(width)
  };
}

function rotateThroughCarryI64(
  op: CarryRotateOp,
  value: Integer<32>,
  carry: BitValue,
  count: Integer<8>
): RotateResult<32> {
  const ring = value.unsigned.extend(64).or(carry.unsigned.extend(64).shl(32));
  const rotated = rotateRing(op, 33, ring, count);

  return {
    result: rotated.truncate(32),
    carry: rotated.bit(32)
  };
}

function throughCarryCount(width: OperandWidth, count: Integer<8>): Integer<8> {
  switch (width) {
    case 8:
      return count.unsigned.rem(9);
    case 16:
      return count.unsigned.rem(17);
    case 32:
      return count;
  }
}
