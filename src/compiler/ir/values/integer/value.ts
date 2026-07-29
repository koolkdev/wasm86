import { assert } from "#common/assert.js";
import type {
  BinaryOperator,
  BitCountOperator,
  CompareOperator
} from "#compiler/integer/operators.js";
import {
  carrierTypeForWidth,
  type CarrierTypeForWidth,
  type IntegerWidth
} from "#compiler/integer/width.js";
import type { ValueId, ValueType } from "#compiler/value.js";
import { resolveValue, type ValueHandle } from "../handle.js";
import { binaryValue } from "../graph/binary.js";
import { bitCountValue } from "../graph/bit-count.js";
import { comparisonValue } from "../graph/comparison.js";
import { constantValue } from "../graph/leaves.js";
import type { ValueNode } from "../graph/node.js";
import { zeroTestValue } from "../graph/zero-test.js";
import {
  boundExpression,
  operationExpression,
  type ValueExpression,
  type ValueOperation,
  type ValueResolutionContext,
  type ValueScopeRequirement
} from "../expression.js";
import { signednessView } from "./signed.js";
import { truncateInteger } from "./width.js";
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

export function operationValue<Width extends IntegerWidth, Input, Args, Node extends ValueNode>(
  width: Width,
  operation: ValueOperation<Input, Args, Node>,
  input: NoInfer<Input>
): Integer<Width> {
  return new IntegerValue(width, operationExpression(operation, input));
}

export function boundValue<Width extends IntegerWidth>(
  width: Width,
  requirement: ValueScopeRequirement
): Integer<Width> {
  return new IntegerValue(width, boundExpression(requirement));
}

class IntegerValue<Width extends IntegerWidth> implements Integer<Width> {
  readonly type: CarrierTypeForWidth<Width>;
  readonly signed: SignedView<Width>;
  readonly unsigned: UnsignedView<Width>;

  constructor(
    readonly width: Width,
    private readonly expression: ValueExpression
  ) {
    this.type = carrierTypeForWidth(width);
    this.signed = signednessView(this, "signed");
    this.unsigned = signednessView(this, "unsigned");
  }

  [resolveValue](context: ValueResolutionContext): ValueId {
    const id = this.expression.resolve(context);
    const actualWidth = context.bitWidth(id);

    assert(
      actualWidth === this.width,
      `${this.width}-bit expression produced a ${actualWidth}-bit value`
    );
    return id;
  }

  add(this: Integer<Width>, other: IntegerOperand<Width>): Integer<Width> {
    return binary(this, "add", other);
  }

  sub(this: Integer<Width>, other: IntegerOperand<Width>): Integer<Width> {
    return binary(this, "sub", other);
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
    return operationValue(1, zeroTestValue, { operator: "eqz", value: this });
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
  truncate(this: Integer<Width>, width: IntegerWidth): ValueHandle<ValueType> {
    return truncateInteger(this, width);
  }
}

export function binary<Width extends IntegerWidth>(
  left: Integer<Width>,
  operator: BinaryOperator,
  right: IntegerOperand<Width>
): Integer<Width> {
  return operationValue(left.width, binaryValue, {
    operator,
    a: left,
    b: operandValue(left, right)
  });
}

export function shift<Width extends IntegerWidth>(
  value: Integer<Width>,
  operator: Extract<BinaryOperator, "shl" | "shr_s" | "shr_u" | "rotl" | "rotr">,
  count: ShiftCount
): Integer<Width> {
  return operationValue(value.width, binaryValue, {
    operator,
    a: value,
    b: shiftCountValue(count)
  });
}

export function compare<Width extends IntegerWidth>(
  left: Integer<Width>,
  operator: CompareOperator,
  right: IntegerOperand<Width>
): BitValue {
  return operationValue(1, comparisonValue, {
    operator,
    a: left,
    b: operandValue(left, right)
  });
}

function bitCount<Width extends IntegerWidth>(
  value: Integer<Width>,
  operator: BitCountOperator
): Integer<Width> {
  return operationValue(value.width, bitCountValue, { operator, value });
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
      return operationValue(1, constantValue, { width: 1, value });
    case 8:
      assert(typeof value === "number", "8-bit operands use number literals");
      return operationValue(8, constantValue, { width: 8, value });
    case 16:
      assert(typeof value === "number", "16-bit operands use number literals");
      return operationValue(16, constantValue, { width: 16, value });
    case 32:
      assert(typeof value === "number", "32-bit operands use number literals");
      return operationValue(32, constantValue, { width: 32, value });
    case 64:
      assert(typeof value === "bigint", "64-bit operands use bigint literals");
      return operationValue(64, constantValue, { width: 64, value });
  }
}

function shiftCountValue(count: ShiftCount): I32Value {
  if (typeof count === "number") {
    return operationValue(32, constantValue, { width: 32, value: count });
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
