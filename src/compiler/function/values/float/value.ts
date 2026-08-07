import { assert } from "#common/assert.js";
import type {
  FloatBinaryOperator,
  FloatCompareOperator
} from "#compiler/function/values/float/type.js";
import type { FloatWidth } from "#compiler/function/values/float/type.js";
import { valueRecord, type FloatRef, type ValueRef } from "#compiler/function/values/reference.js";
import type { BitValue } from "#compiler/function/values/integer/types.js";
import { floatComparisonBit } from "#compiler/function/values/integer/value.js";
import type { FloatRecord, ValueScopeRequirement } from "#compiler/function/values/record.js";
import { floatLiteralBits } from "./fold.js";

type FloatLiteral = number;

export type FloatOperand<Width extends FloatWidth> = Float<NoInfer<Width>> | FloatLiteral;

export interface Float<Width extends FloatWidth> extends FloatRef<Width> {
  readonly kind: "float";
  readonly width: Width;

  readonly add: (this: Float<Width>, other: FloatOperand<Width>) => Float<Width>;
  readonly sub: (this: Float<Width>, other: FloatOperand<Width>) => Float<Width>;
  readonly mul: (this: Float<Width>, other: FloatOperand<Width>) => Float<Width>;
  readonly div: (this: Float<Width>, other: FloatOperand<Width>) => Float<Width>;

  readonly eq: (this: Float<Width>, other: FloatOperand<Width>) => BitValue;
  readonly ne: (this: Float<Width>, other: FloatOperand<Width>) => BitValue;
  readonly lt: (this: Float<Width>, other: FloatOperand<Width>) => BitValue;
  readonly le: (this: Float<Width>, other: FloatOperand<Width>) => BitValue;
  readonly gt: (this: Float<Width>, other: FloatOperand<Width>) => BitValue;
  readonly ge: (this: Float<Width>, other: FloatOperand<Width>) => BitValue;
}

export function f32(value: FloatLiteral): Float<32> {
  return floatConstantBits(32, floatLiteralBits(32, value));
}

export function f64(value: FloatLiteral): Float<64> {
  return floatConstantBits(64, floatLiteralBits(64, value));
}

export function floatConstantBits<Width extends FloatWidth>(
  width: Width,
  bits: number | bigint
): Float<Width> {
  return new FloatValue(width, "float.constant", bits);
}

export function boundFloatValue<Width extends FloatWidth>(
  width: Width,
  requirement: ValueScopeRequirement
): Float<Width> {
  return new FloatValue(
    width,
    "float.bound",
    undefined,
    undefined,
    undefined,
    undefined,
    requirement
  );
}

export function floatSelect<Width extends FloatWidth>(
  width: Width,
  condition: BitValue,
  whenTrue: FloatRef<Width>,
  whenFalse: FloatRef<Width>
): Float<Width> {
  return new FloatValue(width, "float.select", undefined, condition, whenTrue, whenFalse);
}

class FloatValue<Width extends FloatWidth> implements Float<Width> {
  readonly kind = "float";

  constructor(
    readonly width: Width,
    readonly op: FloatRecord["op"],
    readonly attr: FloatRecord["attr"],
    readonly a: ValueRef | undefined = undefined,
    readonly b: ValueRef | undefined = undefined,
    readonly c: ValueRef | undefined = undefined,
    readonly bound: ValueScopeRequirement | undefined = undefined
  ) {}

  // The unforgeable door onto the record: only machinery holding the symbol
  // can read a value's operation.
  [valueRecord](): FloatRecord {
    return this as unknown as FloatRecord;
  }

  add(this: Float<Width>, other: FloatOperand<Width>): Float<Width> {
    return binary(this, "add", other);
  }

  sub(this: Float<Width>, other: FloatOperand<Width>): Float<Width> {
    return binary(this, "sub", other);
  }

  mul(this: Float<Width>, other: FloatOperand<Width>): Float<Width> {
    return binary(this, "mul", other);
  }

  div(this: Float<Width>, other: FloatOperand<Width>): Float<Width> {
    return binary(this, "div", other);
  }

  eq(this: Float<Width>, other: FloatOperand<Width>): BitValue {
    return compare(this, "eq", other);
  }

  ne(this: Float<Width>, other: FloatOperand<Width>): BitValue {
    return compare(this, "ne", other);
  }

  lt(this: Float<Width>, other: FloatOperand<Width>): BitValue {
    return compare(this, "lt", other);
  }

  le(this: Float<Width>, other: FloatOperand<Width>): BitValue {
    return compare(this, "le", other);
  }

  gt(this: Float<Width>, other: FloatOperand<Width>): BitValue {
    return compare(this, "gt", other);
  }

  ge(this: Float<Width>, other: FloatOperand<Width>): BitValue {
    return compare(this, "ge", other);
  }
}

function binary<Width extends FloatWidth>(
  left: Float<Width>,
  operator: FloatBinaryOperator,
  right: FloatOperand<Width>
): Float<Width> {
  return new FloatValue(left.width, "float.binary", operator, left, operandValue(left, right));
}

function compare<Width extends FloatWidth>(
  left: Float<Width>,
  operator: FloatCompareOperator,
  right: FloatOperand<Width>
): BitValue {
  return floatComparisonBit(operator, left, operandValue(left, right));
}

function operandValue<Width extends FloatWidth>(
  receiver: Float<Width>,
  value: FloatOperand<Width>
): Float<Width> {
  if (typeof value === "number") {
    return floatConstantBits(receiver.width, floatLiteralBits(receiver.width, value));
  }
  assert(
    value.kind === "float" && value.width === receiver.width,
    `Float[${value.width}] operand does not match Float[${receiver.width}] receiver`
  );
  return value;
}
