import type { Values } from "#ir/values.js";
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
  return (s, v, context) => {
    const dst = s.operand(0);

    guardStorageReadWrite(s, context, dst, width);

    const value = v.truncate(width, s.get(dst, width));
    const rawCount = readShiftCount(s, v, countSource);
    const count = v.binary("and", rawCount, v.const(0x1f));

    if (op === "rol" || op === "ror") {
      writePlainRotate(s, v, op, width, value, count, dst);
      return;
    }

    writeCarryRotate(s, v, op, width, value, count, dst);
  };
}

function writePlainRotate(
  s: SemanticsBuilder,
  v: Values,
  op: Extract<RotateOp, "rol" | "ror">,
  width: OperandWidth,
  value: Value,
  count: Value,
  dst: StorageInput
): void {
  const effective = rotateCount(v, width, count);
  const result = v.truncate(width, rotateI32(v, rotateDirection(op), width, value, effective));
  const ops = semanticFlagOps(v);
  const carry = op === "rol" ? lowBit(ops, result) : signBit(ops, width, result);
  const countIsNonZero = countNonZero(v, count);

  writeRotateFlags(s, v, {
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
  v: Values,
  op: Extract<RotateOp, "rcl" | "rcr">,
  width: OperandWidth,
  value: Value,
  count: Value,
  dst: StorageInput
): void {
  const oldCf = s.readFlag("CF");
  const effective = throughCarryCount(v, width, count);
  const effectiveNonZero = countNonZero(v, effective);
  const rotated = rotateThroughCarry(v, op, width, value, oldCf, effective);
  const result = v.select(effectiveNonZero, rotated.result, value);
  const carry = v.select(effectiveNonZero, rotated.carry, oldCf);

  writeRotateFlags(s, v, {
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
  v: Values,
  direction: RotateDirection,
  bits: number,
  value: Value,
  count: Value
): Value {
  if (bits === 32) {
    return v.binary(direction === "left" ? "rotl" : "rotr", value, count);
  }

  const backCount = v.binary("sub", v.const(bits), count);

  return direction === "left"
    ? v.binary("or", v.binary("shl", value, count), v.binary("shr_u", value, backCount))
    : v.binary("or", v.binary("shr_u", value, count), v.binary("shl", value, backCount));
}

function rotateI64(
  v: Values,
  direction: RotateDirection,
  bits: number,
  value: Value,
  count: Value
): Value {
  const count64 = extendU64(v, count);
  const backCount64 = extendU64(v, v.binary("sub", v.const(bits), count));

  return direction === "left"
    ? v.binary64("or", v.binary64("shl", value, count64), v.binary64("shr_u", value, backCount64))
    : v.binary64("or", v.binary64("shr_u", value, count64), v.binary64("shl", value, backCount64));
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
  v: Values,
  op: Extract<RotateOp, "rcl" | "rcr">,
  width: OperandWidth,
  value: Value,
  carry: Value,
  count: Value
): RotateResult {
  switch (width) {
    case 8:
    case 16:
      return rotateThroughCarry32(v, op, width, value, carry, count);
    case 32:
      return rotateThroughCarry64(v, op, value, carry, count);
  }
}

function rotateThroughCarry32(
  v: Values,
  op: Extract<RotateOp, "rcl" | "rcr">,
  width: Extract<OperandWidth, 8 | 16>,
  value: Value,
  carry: Value,
  count: Value
): RotateResult {
  const ring = buildThroughCarryRing32(v, width, value, carry);
  const rotated = rotateRing32(v, op, ring, count);

  return {
    result: v.truncate(width, rotated),
    carry: bitAt(semanticFlagOps(v), rotated, width)
  };
}

function buildThroughCarryRing32(
  v: Values,
  width: Extract<OperandWidth, 8 | 16>,
  value: Value,
  carry: Value
): RotateRing32 {
  return {
    bits: width + 1,
    value: v.binary("or", value, v.binary("shl", carry, v.const(width)))
  };
}

function rotateRing32(
  v: Values,
  op: Extract<RotateOp, "rcl" | "rcr">,
  ring: RotateRing32,
  count: Value
): Value {
  return rotateI32(v, rotateDirection(op), ring.bits, ring.value, count);
}

function rotateThroughCarry64(
  v: Values,
  op: Extract<RotateOp, "rcl" | "rcr">,
  value: Value,
  carry: Value,
  count: Value
): RotateResult {
  const ring = buildThroughCarryRing64(v, value, carry);
  const rotated = rotateRing64(v, op, ring, count);

  return {
    result: v.truncate64(32, rotated),
    carry: lowBit(
      semanticFlagOps(v),
      v.truncate64(32, v.binary64("shr_u", rotated, extendU64(v, v.const(32))))
    )
  };
}

function buildThroughCarryRing64(
  v: Values,
  value: Value,
  carry: Value
): Value {
  return v.binary64(
    "or",
    extendU64(v, value),
    v.binary64("shl", extendU64(v, carry), extendU64(v, v.const(32)))
  );
}

function rotateRing64(
  v: Values,
  op: Extract<RotateOp, "rcl" | "rcr">,
  ring: Value,
  count: Value
): Value {
  return rotateI64(v, rotateDirection(op), 33, ring, count);
}

function extendU64(v: Values, value: Value): Value {
  return v.extend64(32, value, false);
}

function rotateCount(v: Values, width: OperandWidth, count: Value): Value {
  switch (width) {
    case 8:
      return v.binary("and", count, v.const(7));
    case 16:
      return v.binary("and", count, v.const(15));
    case 32:
      return count;
  }
}

function throughCarryCount(v: Values, width: OperandWidth, count: Value): Value {
  switch (width) {
    case 8:
      return v.binary("rem_u", count, v.const(9));
    case 16:
      return v.binary("rem_u", count, v.const(17));
    case 32:
      return count;
  }
}

function countNonZero(v: Values, count: Value): Value {
  return v.compare(32, "ne", count, v.const(0));
}
