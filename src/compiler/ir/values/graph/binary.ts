import { assert } from "#common/assert.js";
import type { BinaryOperator } from "#compiler/integer/operators.js";
import type { ValueFoldContext } from "./definition.js";
import type { ValueOperation } from "../expression.js";
import { normalizeInteger, signedInteger } from "./integer.js";
import { effectiveShiftAmount, type IntegerWidth } from "#compiler/integer/width.js";
import type { ValueId } from "#compiler/ir/value.js";
import type { ValueHandle } from "../handle.js";

type BinaryOperands<Value> = Readonly<{
  operator: BinaryOperator;
  a: Value;
  b: Value;
}>;

type BinaryInput = BinaryOperands<ValueHandle>;
type BinaryArgs = BinaryOperands<ValueId>;

export type BinaryNode = Readonly<BinaryArgs & { kind: "binary" }>;

export const binaryValue: ValueOperation<BinaryInput, BinaryArgs, BinaryNode> = {
  resolve: ({ operator, a, b }, values) => ({
    operator,
    a: values.value(a),
    b: values.value(b)
  }),
  create: ({ operator, a, b }) => ({ kind: "binary", operator, a, b }),
  identity: {
    kind: "scoped",
    key: (node) => [node.operator, node.a, node.b]
  },
  children: (node) => [node.a, node.b],
  bitWidth: (node, context) => context.bitWidth(node.a),
  validate: (node, context) => {
    const width = context.bitWidth(node.a);
    const rightWidth = context.bitWidth(node.b);

    assert(
      (["shl", "shr_s", "shr_u", "rotl", "rotr"] as readonly BinaryOperator[]).includes(
        node.operator
      )
        ? rightWidth === 32
        : rightWidth === width,
      `${node.operator} has invalid ${rightWidth}-bit right operand for ${width}-bit left operand`
    );
  },
  fold: (node, context) => foldBinary(node, context)
};

function foldBinary(node: BinaryNode, context: ValueFoldContext): ValueId | undefined {
  const width = context.bitWidth(node.a);
  const left = context.constant(node.a);
  const right = context.constant(node.b);

  if (left !== undefined && right !== undefined) {
    if (binaryConstantIsUndefined(node.operator, width, left, right)) {
      return context.unreachable(width);
    }

    return context.constantValue(width, evaluateDefinedBinary(node.operator, width, left, right));
  }

  switch (node.operator) {
    case "add":
      return right === 0n ? node.a : left === 0n ? node.b : undefined;
    case "sub":
      if (right === 0n) {
        return node.a;
      }
      return node.a === node.b ? context.constantValue(width, 0n) : undefined;
    case "mul":
      if (right === 1n) {
        return node.a;
      }
      if (left === 1n) {
        return node.b;
      }
      return right === 0n || left === 0n ? context.constantValue(width, 0n) : undefined;
    case "div_s":
    case "div_u":
      return right === 1n ? node.a : undefined;
    case "rem_s":
      return right === 1n || right === normalizeInteger(width, -1n)
        ? context.constantValue(width, 0n)
        : undefined;
    case "rem_u":
      return right === 1n ? context.constantValue(width, 0n) : undefined;
    case "xor":
      if (right === 0n) {
        return node.a;
      }
      if (left === 0n) {
        return node.b;
      }
      return node.a === node.b ? context.constantValue(width, 0n) : undefined;
    case "or":
      if (right === 0n || node.a === node.b) {
        return node.a;
      }
      if (left === 0n) {
        return node.b;
      }
      if (right === normalizeInteger(width, -1n)) {
        return node.b;
      }
      return left === normalizeInteger(width, -1n) ? node.a : undefined;
    case "and":
      if (node.a === node.b || right === normalizeInteger(width, -1n)) {
        return node.a;
      }
      if (left === normalizeInteger(width, -1n)) {
        return node.b;
      }
      if (right === 0n || left === 0n) {
        return context.constantValue(width, 0n);
      }
      return undefined;
    case "shl":
    case "shr_s":
    case "shr_u":
      if (right !== undefined && effectiveShiftAmount(width, right) === 0) {
        return node.a;
      }
      return left === 0n ? context.constantValue(width, 0n) : undefined;
    case "rotl":
    case "rotr":
      return right !== undefined && rotateAmount(width, right) === 0 ? node.a : undefined;
  }
}

function evaluateDefinedBinary(
  operator: BinaryOperator,
  width: IntegerWidth,
  left: bigint,
  right: bigint
): bigint {
  switch (operator) {
    case "add":
      return normalizeInteger(width, left + right);
    case "sub":
      return normalizeInteger(width, left - right);
    case "mul":
      return normalizeInteger(width, left * right);
    case "div_s": {
      const divisor = signedInteger(width, right);
      const dividend = signedInteger(width, left);

      return normalizeInteger(width, dividend / divisor);
    }
    case "div_u":
      return normalizeInteger(width, left / right);
    case "rem_s": {
      const divisor = signedInteger(width, right);

      return normalizeInteger(width, signedInteger(width, left) % divisor);
    }
    case "rem_u":
      return normalizeInteger(width, left % right);
    case "xor":
      return normalizeInteger(width, left ^ right);
    case "or":
      return normalizeInteger(width, left | right);
    case "and":
      return normalizeInteger(width, left & right);
    case "shl":
      return normalizeInteger(width, left << BigInt(effectiveShiftAmount(width, right)));
    case "shr_s":
      return normalizeInteger(
        width,
        signedInteger(width, left) >> BigInt(effectiveShiftAmount(width, right))
      );
    case "shr_u":
      return normalizeInteger(width, left >> BigInt(effectiveShiftAmount(width, right)));
    case "rotl":
      return rotateLeft(width, left, rotateAmount(width, right));
    case "rotr":
      return rotateRight(width, left, rotateAmount(width, right));
  }
}

function binaryConstantIsUndefined(
  operator: BinaryOperator,
  width: IntegerWidth,
  left: bigint,
  right: bigint
): boolean {
  switch (operator) {
    case "div_s":
      return (
        right === 0n ||
        (width >= 32 &&
          signedInteger(width, right) === -1n &&
          signedInteger(width, left) === minimumSigned(width))
      );
    case "div_u":
    case "rem_s":
    case "rem_u":
      return right === 0n;
    default:
      return false;
  }
}

function rotateAmount(width: IntegerWidth, value: bigint): number {
  return Number(value % BigInt(width));
}

function rotateLeft(width: IntegerWidth, value: bigint, count: number): bigint {
  if (count === 0) {
    return normalizeInteger(width, value);
  }

  return normalizeInteger(width, (value << BigInt(count)) | (value >> BigInt(width - count)));
}

function rotateRight(width: IntegerWidth, value: bigint, count: number): bigint {
  if (count === 0) {
    return normalizeInteger(width, value);
  }

  return normalizeInteger(width, (value >> BigInt(count)) | (value << BigInt(width - count)));
}

function minimumSigned(width: IntegerWidth): bigint {
  return -(1n << BigInt(width - 1));
}
