import {
  valueExpression,
  type FloatRef,
  type ValueExpression,
  type ValueSource,
  type ValueRef
} from "#compiler/function/values/expression.js";
import type { BitValue } from "#compiler/function/values/integer/types.js";
import { comparisonBit } from "#compiler/function/values/integer/value.js";
import { floatBits } from "./bits.js";
import type { FloatBinaryOperator, FloatCompareOperator, FloatWidth } from "./types.js";

type FloatLiteral = number;
type FloatResultExpression = Extract<ValueExpression, { kind: "float" }>;

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

type AnyFloat = Float<32> | Float<64>;

export function f32(value: FloatLiteral): Float<32> {
  return floatConstantBits(32, floatBits(32, value));
}

export function f64(value: FloatLiteral): Float<64> {
  return floatConstantBits(64, floatBits(64, value));
}

export function floatConstantBits(width: 32, bits: number): Float<32>;
export function floatConstantBits(width: 64, bits: bigint): Float<64>;
export function floatConstantBits(width: FloatWidth, bits: number | bigint): AnyFloat;
export function floatConstantBits(width: FloatWidth, bits: number | bigint): AnyFloat {
  return width === 32
    ? new FloatValue(32, "float.constant", bits as number)
    : new FloatValue(64, "float.constant", bits as bigint);
}

export function floatFromSource<Width extends FloatWidth>(
  width: Width,
  source: ValueSource
): Float<Width> {
  return new FloatValue(width, "value.source", source);
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
    readonly op: FloatResultExpression["op"],
    readonly attr: FloatResultExpression["attr"],
    readonly a: ValueRef | undefined = undefined,
    readonly b: ValueRef | undefined = undefined,
    readonly c: ValueRef | undefined = undefined
  ) {}

  [valueExpression](): FloatResultExpression {
    return this as unknown as FloatResultExpression;
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
  return comparisonBit("float.compare", operator, left, operandValue(left, right));
}

function operandValue<Width extends FloatWidth>(
  receiver: Float<Width>,
  value: FloatOperand<Width>
): Float<Width> {
  return typeof value === "number" ? floatConstant(receiver.width, value) : value;
}

function floatConstant<Width extends FloatWidth>(width: Width, value: number): Float<Width>;
function floatConstant(width: FloatWidth, value: number): AnyFloat;
function floatConstant(width: FloatWidth, value: number): AnyFloat {
  return width === 32 ? f32(value) : f64(value);
}
