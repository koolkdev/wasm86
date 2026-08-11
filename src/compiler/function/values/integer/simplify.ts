import type { IntegerExpression, IntegerRef } from "#compiler/function/values/expression.js";
import type { ValueResolution } from "#compiler/function/values/resolver.js";
import type { CompareOperator } from "./operators.js";
import {
  effectiveRotateAmount,
  effectiveShiftAmount,
  evaluateBinary,
  evaluateBitCount,
  evaluateComparison,
  evaluateExtension,
  evaluateTruncation,
  evaluateZeroTest
} from "./evaluate.js";
import { integerConstant, integerZeroTest } from "./value.js";
import { normalizeInteger } from "./width.js";

type IntegerOperation = Extract<
  IntegerExpression,
  {
    op:
      | "integer.binary"
      | "integer.compare"
      | "integer.zeroTest"
      | "integer.bitCount"
      | "integer.extend"
      | "integer.truncate";
  }
>;

export function simplifyInteger(
  expression: IntegerOperation,
  a: ValueResolution | undefined,
  b: ValueResolution | undefined
): IntegerRef | undefined {
  switch (expression.op) {
    case "integer.binary":
      return simplifyBinary(expression, a, b);
    case "integer.compare":
      return simplifyComparison(expression, a, b);
    case "integer.zeroTest": {
      if (expression.attr === "nonzero" && expression.a.width === 1) {
        return expression.a;
      }
      const value = integerConstantOf(a);

      return value === undefined
        ? undefined
        : integerConstant(1, evaluateZeroTest(expression.attr, value) ? 1n : 0n);
    }
    case "integer.bitCount": {
      const value = integerConstantOf(a);

      return value === undefined
        ? undefined
        : integerConstant(
            expression.width,
            evaluateBitCount(expression.attr, expression.width, value)
          );
    }
    case "integer.extend": {
      const value = integerConstantOf(a);

      return value === undefined
        ? undefined
        : integerConstant(
            expression.width,
            evaluateExtension(expression.width, expression.a.width, expression.attr, value)
          );
    }
    case "integer.truncate": {
      const value = integerConstantOf(a);

      return value === undefined
        ? undefined
        : integerConstant(expression.width, evaluateTruncation(expression.width, value));
    }
  }
}

function simplifyBinary(
  expression: Extract<IntegerExpression, { op: "integer.binary" }>,
  a: ValueResolution | undefined,
  b: ValueResolution | undefined
): IntegerRef | undefined {
  const left = integerConstantOf(a);
  const right = integerConstantOf(b);

  if (left !== undefined && right !== undefined) {
    const result = evaluateBinary(expression.attr, expression.width, left, right);

    return result === undefined ? undefined : integerConstant(expression.width, result);
  }
  const sameOperands = a !== undefined && a.identity === b?.identity;
  const allBits = normalizeInteger(expression.width, -1n);

  switch (expression.attr) {
    case "add":
      return right === 0n ? expression.a : left === 0n ? expression.b : undefined;
    case "sub":
      if (right === 0n) {
        return expression.a;
      }
      return sameOperands ? integerConstant(expression.width, 0n) : undefined;
    case "mul":
      if (right === 1n) {
        return expression.a;
      }
      if (left === 1n) {
        return expression.b;
      }
      return right === 0n || left === 0n ? integerConstant(expression.width, 0n) : undefined;
    case "div_s":
    case "div_u":
      return right === 1n ? expression.a : undefined;
    case "rem_s":
      return right === 1n || right === allBits ? integerConstant(expression.width, 0n) : undefined;
    case "rem_u":
      return right === 1n ? integerConstant(expression.width, 0n) : undefined;
    case "xor":
      if (right === 0n) {
        return expression.a;
      }
      if (left === 0n) {
        return expression.b;
      }
      return sameOperands ? integerConstant(expression.width, 0n) : undefined;
    case "or":
      if (right === 0n || sameOperands) {
        return expression.a;
      }
      if (left === 0n) {
        return expression.b;
      }
      if (right === allBits) {
        return expression.b;
      }
      return left === allBits ? expression.a : undefined;
    case "and":
      if (sameOperands || right === allBits) {
        return expression.a;
      }
      if (left === allBits) {
        return expression.b;
      }
      return right === 0n || left === 0n ? integerConstant(expression.width, 0n) : undefined;
    case "shl":
    case "shr_s":
    case "shr_u":
      if (right !== undefined && effectiveShiftAmount(expression.width, right) === 0) {
        return expression.a;
      }
      return left === 0n ? integerConstant(expression.width, 0n) : undefined;
    case "rotl":
    case "rotr":
      return right !== undefined && effectiveRotateAmount(expression.width, right) === 0
        ? expression.a
        : undefined;
  }
}

function simplifyComparison(
  expression: Extract<IntegerExpression, { op: "integer.compare" }>,
  a: ValueResolution | undefined,
  b: ValueResolution | undefined
): IntegerRef | undefined {
  const left = integerConstantOf(a);
  const right = integerConstantOf(b);

  if (left !== undefined && right !== undefined) {
    return integerConstant(
      1,
      evaluateComparison(expression.attr, expression.a.width, left, right) ? 1n : 0n
    );
  }
  if (a !== undefined && a.identity === b?.identity) {
    return integerConstant(1, comparisonOfSameValue(expression.attr) ? 1n : 0n);
  }
  if (expression.attr === "eq" || expression.attr === "ne") {
    const operator = expression.attr === "eq" ? "eqz" : "nonzero";

    if (left === 0n) {
      return integerZeroTest(operator, expression.b);
    }
    if (right === 0n) {
      return integerZeroTest(operator, expression.a);
    }
  }
  return undefined;
}

function integerConstantOf(resolution: ValueResolution | undefined): bigint | undefined {
  const expression = resolution?.expression;

  return expression?.op === "integer.constant" ? expression.attr : undefined;
}

function comparisonOfSameValue(operator: CompareOperator): boolean {
  switch (operator) {
    case "eq":
    case "le_u":
    case "ge_u":
    case "le_s":
    case "ge_s":
      return true;
    case "ne":
    case "lt_u":
    case "gt_u":
    case "lt_s":
    case "gt_s":
      return false;
  }
}
