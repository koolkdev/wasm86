import {
  valueExpression,
  type IntegerExpression,
  type IntegerRef
} from "#compiler/function/values/expression.js";
import type {
  BinaryOperator,
  BitCountOperator,
  CompareOperator,
  ZeroTestOperator
} from "#compiler/function/values/integer/operators.js";
import {
  normalizeInteger,
  type IntegerWidth,
  type WidthsAtLeast,
  type WidthsAtMost
} from "#compiler/function/values/integer/width.js";
import type {
  AnyInteger,
  BitValue,
  ExtensionTargets,
  I32Value,
  Integer,
  IntegerOperand,
  ShiftCount,
  Signedness,
  SignednessView,
  SignedView,
  TruncationTargets,
  UnsignedView
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

export function unreachable(): I32Value;
export function unreachable<Width extends IntegerWidth>(width: Width): Integer<Width>;
export function unreachable(width: IntegerWidth = 32): AnyInteger {
  switch (width) {
    case 1:
      return integerUnreachable(1);
    case 8:
      return integerUnreachable(8);
    case 16:
      return integerUnreachable(16);
    case 32:
      return integerUnreachable(32);
    case 64:
      return integerUnreachable(64);
  }
}

export function integerZeroTest(operator: ZeroTestOperator, value: IntegerRef): BitValue {
  return new IntegerValue(1, "integer.zeroTest", operator, value);
}

export function nonzero(value: AnyInteger): BitValue {
  return integerZeroTest("nonzero", value);
}

function integerExtend<Width extends IntegerWidth>(
  width: Width,
  value: IntegerRef,
  signed: boolean
): Integer<Width> {
  return new IntegerValue(width, "integer.extend", signed, value);
}

function integerTruncate<Width extends IntegerWidth>(
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

class IntegerValue<Width extends IntegerWidth> implements Integer<Width> {
  readonly kind = "integer";
  #signed: SignedView<Width> | undefined;
  #unsigned: UnsignedView<Width> | undefined;

  constructor(
    readonly width: Width,
    readonly op: IntegerExpression["op"],
    readonly attr: IntegerExpression["attr"],
    readonly a: IntegerRef | undefined = undefined,
    readonly b: IntegerRef | undefined = undefined,
    readonly c: IntegerRef | undefined = undefined,
    readonly bound: undefined = undefined
  ) {}

  get signed(): SignedView<Width> {
    return (this.#signed ??= new IntegerSignednessView(this, "signed"));
  }

  get unsigned(): UnsignedView<Width> {
    return (this.#unsigned ??= new IntegerSignednessView(this, "unsigned"));
  }

  [valueExpression](): IntegerExpression {
    return this as unknown as IntegerExpression;
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
    return this.unsigned.shr(index).truncate(1);
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
    this: Integer<Width> & Readonly<{ width: WidthsAtLeast<TargetWidth> }>,
    width: TargetWidth
  ): Integer<TargetWidth>;
  truncate(this: Integer<Width>, width: IntegerWidth): IntegerRef {
    return truncateInteger(this, width);
  }
}

class IntegerSignednessView<
  Width extends IntegerWidth,
  Mode extends Signedness
> implements SignednessView<Width, Mode> {
  readonly #value: Integer<Width>;

  constructor(
    value: Integer<Width>,
    readonly signedness: Mode
  ) {
    this.#value = value;
  }

  get width(): Width {
    return this.#value.width;
  }

  div(other: IntegerOperand<Width>): Integer<Width> {
    return binary(this.#value, signedOperator("div", this.signedness), other);
  }

  rem(other: IntegerOperand<Width>): Integer<Width> {
    return binary(this.#value, signedOperator("rem", this.signedness), other);
  }

  shr(count: ShiftCount): Integer<Width> {
    return shift(this.#value, this.signedness === "signed" ? "shr_s" : "shr_u", count);
  }

  lt(other: IntegerOperand<Width>): BitValue {
    return compare(this.#value, signedComparison("lt", this.signedness), other);
  }

  le(other: IntegerOperand<Width>): BitValue {
    return compare(this.#value, signedComparison("le", this.signedness), other);
  }

  gt(other: IntegerOperand<Width>): BitValue {
    return compare(this.#value, signedComparison("gt", this.signedness), other);
  }

  ge(other: IntegerOperand<Width>): BitValue {
    return compare(this.#value, signedComparison("ge", this.signedness), other);
  }

  extend<TargetWidth extends ExtensionTargets<Width>>(
    this: SignednessView<Width, Mode>,
    width: TargetWidth
  ): Integer<TargetWidth>;
  extend<TargetWidth extends IntegerWidth>(
    this: SignednessView<Width, Mode> & Readonly<{ width: WidthsAtMost<TargetWidth> }>,
    width: TargetWidth
  ): Integer<TargetWidth>;
  extend(width: IntegerWidth): IntegerRef {
    return extendInteger(this.#value, this.signedness, width);
  }
}

function binary<Width extends IntegerWidth>(
  left: Integer<Width>,
  operator: BinaryOperator,
  right: IntegerOperand<Width>
): Integer<Width> {
  return new IntegerValue(left.width, "integer.binary", operator, left, operandValue(left, right));
}

function shift<Width extends IntegerWidth>(
  value: Integer<Width>,
  operator: Extract<BinaryOperator, "shl" | "shr_s" | "shr_u" | "rotl" | "rotr">,
  count: ShiftCount
): Integer<Width> {
  return new IntegerValue(value.width, "integer.binary", operator, value, shiftCountValue(count));
}

function compare<Width extends IntegerWidth>(
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

function operandValue<Width extends IntegerWidth>(
  receiver: Integer<Width>,
  value: IntegerOperand<Width>
): Integer<Width>;
function operandValue(receiver: AnyInteger, value: AnyInteger | number | bigint): AnyInteger {
  if (typeof value !== "number" && typeof value !== "bigint") {
    return value;
  }

  switch (receiver.width) {
    case 1:
      return integerConstant(1, value);
    case 8:
      return integerConstant(8, value);
    case 16:
      return integerConstant(16, value);
    case 32:
      return integerConstant(32, value);
    case 64:
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

function extendInteger<Width extends IntegerWidth, TargetWidth extends ExtensionTargets<Width>>(
  value: Integer<Width>,
  signedness: Signedness,
  width: TargetWidth
): Integer<TargetWidth>;
function extendInteger(value: IntegerRef, signedness: Signedness, width: IntegerWidth): IntegerRef;
function extendInteger(value: IntegerRef, signedness: Signedness, width: IntegerWidth): IntegerRef {
  return width === value.width ? value : integerExtend(width, value, signedness === "signed");
}

function truncateInteger<Width extends IntegerWidth, TargetWidth extends TruncationTargets<Width>>(
  value: Integer<Width>,
  width: TargetWidth
): Integer<TargetWidth>;
function truncateInteger(value: IntegerRef, width: IntegerWidth): IntegerRef;
function truncateInteger(value: IntegerRef, width: IntegerWidth): IntegerRef {
  return width === value.width ? value : integerTruncate(width, value);
}

function signedOperator(operation: "div" | "rem", signedness: Signedness): BinaryOperator {
  return `${operation}_${signedness === "signed" ? "s" : "u"}`;
}

function signedComparison(
  operation: "lt" | "le" | "gt" | "ge",
  signedness: Signedness
): CompareOperator {
  return `${operation}_${signedness === "signed" ? "s" : "u"}`;
}
