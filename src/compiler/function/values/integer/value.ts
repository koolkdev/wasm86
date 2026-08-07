import { assert } from "#common/assert.js";
import type {
  BinaryOperator,
  BitCountOperator,
  CompareOperator
} from "#compiler/function/values/integer/operators.js";
import type { FloatCompareOperator } from "#compiler/function/values/float/type.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import { valueRecord, type FloatRef, type IntegerRef, type ValueRef } from "../reference.js";
import { normalizeInteger } from "./fold-rules.js";
import type { IntegerRecord, ValueScopeRequirement, ZeroTestOperator } from "../record.js";
import { signednessView } from "./signed.js";
import { truncateInteger } from "./conversion.js";
import type {
  AnyInteger,
  IntegerOperand,
  BitValue,
  Integer,
  I32Value,
  ShiftCount,
  SignedView,
  TruncationTargets,
  UnsignedView,
  WidthsAtLeast
} from "./types.js";

export function integerConstant<Width extends IntegerWidth>(
  width: Width,
  value: number | bigint
): Integer<Width> {
  return new IntegerValue(width, "integer.constant", normalizeInteger(width, value));
}

export function integerUnreachable<Width extends IntegerWidth>(width: Width): Integer<Width> {
  return new IntegerValue(width, "integer.unreachable", undefined);
}

export function integerZeroTest(operator: ZeroTestOperator, value: IntegerRef): BitValue {
  return new IntegerValue(1, "integer.zeroTest", operator, value);
}

export function floatComparisonBit(
  operator: FloatCompareOperator,
  a: FloatRef,
  b: FloatRef
): BitValue {
  return new IntegerValue(1, "float.compare", operator, a, b);
}

export function integerExtend<Width extends IntegerWidth>(
  width: Width,
  value: IntegerRef,
  signed: boolean
): Integer<Width> {
  return new IntegerValue(width, "integer.extend", signed, value);
}

export function integerTruncate<Width extends IntegerWidth>(
  width: Width,
  value: IntegerRef
): Integer<Width> {
  return new IntegerValue(width, "integer.truncate", undefined, value);
}

export function integerSelect<Width extends IntegerWidth>(
  width: Width,
  condition: BitValue,
  whenTrue: IntegerRef<Width>,
  whenFalse: IntegerRef<Width>
): Integer<Width> {
  return new IntegerValue(width, "integer.select", undefined, condition, whenTrue, whenFalse);
}

export function boundValue<Width extends IntegerWidth>(
  width: Width,
  requirement: ValueScopeRequirement
): Integer<Width> {
  return new IntegerValue(
    width,
    "integer.bound",
    undefined,
    undefined,
    undefined,
    undefined,
    requirement
  );
}

class IntegerValue<Width extends IntegerWidth> implements Integer<Width> {
  readonly kind = "integer";
  #signed: SignedView<Width> | undefined;
  #unsigned: UnsignedView<Width> | undefined;

  constructor(
    readonly width: Width,
    readonly op: IntegerRecord["op"],
    readonly attr: IntegerRecord["attr"],
    readonly a: ValueRef | undefined = undefined,
    readonly b: ValueRef | undefined = undefined,
    readonly c: ValueRef | undefined = undefined,
    readonly bound: ValueScopeRequirement | undefined = undefined
  ) {}

  get signed(): SignedView<Width> {
    return (this.#signed ??= signednessView(this, "signed"));
  }

  get unsigned(): UnsignedView<Width> {
    return (this.#unsigned ??= signednessView(this, "unsigned"));
  }

  // The unforgeable door onto the record: only machinery holding the symbol
  // can read a value's operation.
  [valueRecord](): IntegerRecord {
    return this as unknown as IntegerRecord;
  }

  add(this: Integer<Width>, other: IntegerOperand<Width>): Integer<Width> {
    return binary(this, "add", other);
  }

  addWithCarry(
    this: Integer<Width>,
    other: IntegerOperand<Width>,
    carry: BitValue
  ): Integer<Width> {
    const sum = this.add(other);

    return sum.add(carry.unsigned.extend(sum.width));
  }

  sub(this: Integer<Width>, other: IntegerOperand<Width>): Integer<Width> {
    return binary(this, "sub", other);
  }

  subWithBorrow(
    this: Integer<Width>,
    other: IntegerOperand<Width>,
    borrow: BitValue
  ): Integer<Width> {
    const difference = this.sub(other);

    return difference.sub(borrow.unsigned.extend(difference.width));
  }

  mul(this: Integer<Width>, other: IntegerOperand<Width>): Integer<Width> {
    return binary(this, "mul", other);
  }

  and(this: Integer<Width>, other: IntegerOperand<Width>): Integer<Width> {
    return binary(this, "and", other);
  }

  or(this: Integer<Width>, other: IntegerOperand<Width>): Integer<Width> {
    return binary(this, "or", other);
  }

  xor(this: Integer<Width>, other: IntegerOperand<Width>): Integer<Width> {
    return binary(this, "xor", other);
  }

  shl(this: Integer<Width>, count: ShiftCount): Integer<Width> {
    return shift(this, "shl", count);
  }

  rotl(this: Integer<Width>, count: ShiftCount): Integer<Width> {
    return shift(this, "rotl", count);
  }

  rotr(this: Integer<Width>, count: ShiftCount): Integer<Width> {
    return shift(this, "rotr", count);
  }

  eq(this: Integer<Width>, other: IntegerOperand<Width>): BitValue {
    return compare(this, "eq", other);
  }

  ne(this: Integer<Width>, other: IntegerOperand<Width>): BitValue {
    return compare(this, "ne", other);
  }

  eqz(this: Integer<Width>): BitValue {
    return integerZeroTest("eqz", this);
  }

  bit(this: Integer<Width>, index: ShiftCount): BitValue {
    return bitValue(this, index);
  }

  msb(this: Integer<Width>): BitValue {
    return this.bit(this.width - 1);
  }

  popcnt(this: Integer<Width>): Integer<Width> {
    return bitCount(this, "popcnt");
  }

  ctz(this: Integer<Width>): Integer<Width> {
    return bitCount(this, "ctz");
  }

  clz(this: Integer<Width>): Integer<Width> {
    return bitCount(this, "clz");
  }

  truncate<TargetWidth extends TruncationTargets<Width>>(
    this: Integer<Width>,
    width: TargetWidth
  ): Integer<TargetWidth>;
  truncate<TargetWidth extends IntegerWidth>(
    this: Integer<Width> &
      Readonly<{
        width: WidthsAtLeast<TargetWidth>;
      }>,
    width: TargetWidth
  ): Integer<TargetWidth>;
  truncate(this: Integer<Width>, width: IntegerWidth): ValueRef {
    return truncateInteger(this, width);
  }
}

export function binary<Width extends IntegerWidth>(
  left: Integer<Width>,
  operator: BinaryOperator,
  right: IntegerOperand<Width>
): Integer<Width> {
  return new IntegerValue(left.width, "integer.binary", operator, left, operandValue(left, right));
}

export function shift<Width extends IntegerWidth>(
  value: Integer<Width>,
  operator: Extract<BinaryOperator, "shl" | "shr_s" | "shr_u" | "rotl" | "rotr">,
  count: ShiftCount
): Integer<Width> {
  return new IntegerValue(value.width, "integer.binary", operator, value, shiftCountValue(count));
}

export function compare<Width extends IntegerWidth>(
  left: Integer<Width>,
  operator: CompareOperator,
  right: IntegerOperand<Width>
): BitValue {
  return new IntegerValue(1, "integer.compare", operator, left, operandValue(left, right));
}

function bitCount<Width extends IntegerWidth>(
  value: Integer<Width>,
  operator: BitCountOperator
): Integer<Width> {
  return new IntegerValue(value.width, "integer.bitCount", operator, value);
}

function bitValue<Width extends IntegerWidth>(value: Integer<Width>, index: ShiftCount): BitValue {
  return value.unsigned.shr(index).truncate(1);
}

function operandValue<Width extends IntegerWidth>(
  receiver: Integer<Width>,
  value: IntegerOperand<Width>
): Integer<Width>;
function operandValue(receiver: AnyInteger, value: AnyInteger | number | bigint): AnyInteger {
  if (typeof value !== "number" && typeof value !== "bigint") {
    assert(
      value.width === receiver.width,
      `${value.width}-bit operand does not match ${receiver.width}-bit receiver`
    );
    return value;
  }

  switch (receiver.width) {
    case 1:
      assert(typeof value === "number", "1-bit operands use number literals");
      return integerConstant(1, value);
    case 8:
      assert(typeof value === "number", "8-bit operands use number literals");
      return integerConstant(8, value);
    case 16:
      assert(typeof value === "number", "16-bit operands use number literals");
      return integerConstant(16, value);
    case 32:
      assert(typeof value === "number", "32-bit operands use number literals");
      return integerConstant(32, value);
    case 64:
      assert(typeof value === "bigint", "64-bit operands use bigint literals");
      return integerConstant(64, value);
  }
}

function shiftCountValue(count: ShiftCount): I32Value {
  if (typeof count === "number") {
    return integerConstant(32, count);
  }

  switch (count.width) {
    case 1:
      return count.unsigned.extend(32);
    case 8:
      return count.unsigned.extend(32);
    case 16:
      return count.unsigned.extend(32);
    case 32:
      return count;
  }
}
