import type {
  SemanticsBuilder,
  SemanticTemplate
} from "#x86/semantics/builder.js";
import { bitAt, lowBit, signBit } from "#x86/flag-values.js";
import type { StorageInput, Value } from "#x86/semantics/refs.js";
import type { OperandWidth } from "#x86/types.js";
import { semanticFlagOps } from "./flag-value-ops.js";
import { writeRotateFlags } from "./flag-writes.js";
import { guardStorageReadWrite } from "./memory.js";
import { readShiftCount, type ShiftCountSource } from "./shift.js";

export type RotateOp = "rol" | "ror" | "rcl" | "rcr";

type RotateResult = Readonly<{ result: Value; carry: Value }>;
type RotateRing32 = Readonly<{ bits: number; value: Value }>;
type RotateDirection = "left" | "right";

export function rotateSemantic(
  op: RotateOp,
  width: OperandWidth,
  countSource: ShiftCountSource
): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);

    guardStorageReadWrite(s, context, dst, width);

    const value = s.project(width, s.get(dst, width));
    const rawCount = readShiftCount(s, countSource);
    const count = s.binary("and", rawCount, s.const32(0x1f));

    if (op === "rol" || op === "ror") {
      writePlainRotate(s, op, width, value, count, dst);
      return;
    }

    writeCarryRotate(s, op, width, value, count, dst);
  };
}

function writePlainRotate(
  s: SemanticsBuilder,
  op: Extract<RotateOp, "rol" | "ror">,
  width: OperandWidth,
  value: Value,
  count: Value,
  dst: StorageInput
): void {
  const effective = rotateCount(s, width, count);
  const result = s.project(width, rotateI32(s, rotateDirection(op), width, value, effective));
  const ops = semanticFlagOps(s);
  const carry = op === "rol" ? lowBit(ops, result) : signBit(ops, width, result);
  const countIsNonZero = countNonZero(s, count);

  writeRotateFlags(s, {
    op,
    width,
    count,
    result,
    carry,
    carryDefined: countIsNonZero
  });
  s.set(dst, result, width);
}

function writeCarryRotate(
  s: SemanticsBuilder,
  op: Extract<RotateOp, "rcl" | "rcr">,
  width: OperandWidth,
  value: Value,
  count: Value,
  dst: StorageInput
): void {
  const oldCf = s.readFlag("CF");
  const effective = throughCarryCount(s, width, count);
  const effectiveNonZero = countNonZero(s, effective);
  const rotated = rotateThroughCarry(s, op, width, value, oldCf, effective);
  const result = s.select(effectiveNonZero, rotated.result, value);
  const carry = s.select(effectiveNonZero, rotated.carry, oldCf);

  writeRotateFlags(s, {
    op,
    width,
    count,
    result,
    carry,
    carryDefined: effectiveNonZero,
    oldCf
  });
  s.set(dst, result, width);
}

function rotateI32(
  s: SemanticsBuilder,
  direction: RotateDirection,
  bits: number,
  value: Value,
  count: Value
): Value {
  if (bits === 32) {
    return s.binary(direction === "left" ? "rotl" : "rotr", value, count);
  }

  const backCount = s.binary("sub", s.const32(bits), count);

  return direction === "left"
    ? s.binary("or", s.binary("shl", value, count), s.binary("shr_u", value, backCount))
    : s.binary("or", s.binary("shr_u", value, count), s.binary("shl", value, backCount));
}

function rotateI64(
  s: SemanticsBuilder,
  direction: RotateDirection,
  bits: number,
  value: Value,
  count: Value
): Value {
  const count64 = extendU64(s, count);
  const backCount64 = extendU64(s, s.binary("sub", s.const32(bits), count));

  return direction === "left"
    ? s.binary64("or", s.binary64("shl", value, count64), s.binary64("shr_u", value, backCount64))
    : s.binary64("or", s.binary64("shr_u", value, count64), s.binary64("shl", value, backCount64));
}

function rotateDirection(op: RotateOp): RotateDirection {
  switch (op) {
    case "rol":
    case "rcl":
      return "left";
    case "ror":
    case "rcr":
      return "right";
  }
}

function rotateThroughCarry(
  s: SemanticsBuilder,
  op: Extract<RotateOp, "rcl" | "rcr">,
  width: OperandWidth,
  value: Value,
  carry: Value,
  count: Value
): RotateResult {
  switch (width) {
    case 8:
    case 16:
      return rotateThroughCarry32(s, op, width, value, carry, count);
    case 32:
      return rotateThroughCarry64(s, op, value, carry, count);
  }
}

function rotateThroughCarry32(
  s: SemanticsBuilder,
  op: Extract<RotateOp, "rcl" | "rcr">,
  width: Extract<OperandWidth, 8 | 16>,
  value: Value,
  carry: Value,
  count: Value
): RotateResult {
  const ring = buildThroughCarryRing32(s, width, value, carry);
  const rotated = rotateRing32(s, op, ring, count);

  return {
    result: s.project(width, rotated),
    carry: bitAt(semanticFlagOps(s), rotated, width)
  };
}

function buildThroughCarryRing32(
  s: SemanticsBuilder,
  width: Extract<OperandWidth, 8 | 16>,
  value: Value,
  carry: Value
): RotateRing32 {
  return {
    bits: width + 1,
    value: s.binary("or", value, s.binary("shl", carry, s.const32(width)))
  };
}

function rotateRing32(
  s: SemanticsBuilder,
  op: Extract<RotateOp, "rcl" | "rcr">,
  ring: RotateRing32,
  count: Value
): Value {
  return rotateI32(s, rotateDirection(op), ring.bits, ring.value, count);
}

function rotateThroughCarry64(
  s: SemanticsBuilder,
  op: Extract<RotateOp, "rcl" | "rcr">,
  value: Value,
  carry: Value,
  count: Value
): RotateResult {
  const ring = buildThroughCarryRing64(s, value, carry);
  const rotated = rotateRing64(s, op, ring, count);

  return {
    result: s.project64(32, rotated),
    carry: lowBit(
      semanticFlagOps(s),
      s.project64(32, s.binary64("shr_u", rotated, extendU64(s, s.const32(32))))
    )
  };
}

function buildThroughCarryRing64(
  s: SemanticsBuilder,
  value: Value,
  carry: Value
): Value {
  return s.binary64(
    "or",
    extendU64(s, value),
    s.binary64("shl", extendU64(s, carry), extendU64(s, s.const32(32)))
  );
}

function rotateRing64(
  s: SemanticsBuilder,
  op: Extract<RotateOp, "rcl" | "rcr">,
  ring: Value,
  count: Value
): Value {
  return rotateI64(s, rotateDirection(op), 33, ring, count);
}

function extendU64(s: SemanticsBuilder, value: Value): Value {
  return s.extend64(32, value, false);
}

function rotateCount(s: SemanticsBuilder, width: OperandWidth, count: Value): Value {
  switch (width) {
    case 8:
      return s.binary("and", count, s.const32(7));
    case 16:
      return s.binary("and", count, s.const32(15));
    case 32:
      return count;
  }
}

function throughCarryCount(s: SemanticsBuilder, width: OperandWidth, count: Value): Value {
  switch (width) {
    case 8:
      return s.binary("rem_u", count, s.const32(9));
    case 16:
      return s.binary("rem_u", count, s.const32(17));
    case 32:
      return count;
  }
}

function countNonZero(s: SemanticsBuilder, count: Value): Value {
  return s.compare(32, "ne", count, s.const32(0));
}
