import { floatBits, floatFromBits } from "./bits.js";
import type { FloatBinaryOperator, FloatBits, FloatCompareOperator, FloatWidth } from "./types.js";

export function evaluateBinary<Width extends FloatWidth>(
  operator: FloatBinaryOperator,
  width: Width,
  leftBits: FloatBits<Width>,
  rightBits: FloatBits<Width>
): FloatBits<Width> | undefined {
  const left = floatFromBits(width, leftBits);
  const right = floatFromBits(width, rightBits);
  const result = evaluateOperation(operator, left, right);

  if (Number.isNaN(result)) {
    return undefined;
  }
  return floatBits(width, result);
}

export function evaluateComparison<Width extends FloatWidth>(
  operator: FloatCompareOperator,
  width: Width,
  leftBits: FloatBits<Width>,
  rightBits: FloatBits<Width>
): boolean {
  const left = floatFromBits(width, leftBits);
  const right = floatFromBits(width, rightBits);

  switch (operator) {
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "lt":
      return left < right;
    case "le":
      return left <= right;
    case "gt":
      return left > right;
    case "ge":
      return left >= right;
  }
}

function evaluateOperation(operator: FloatBinaryOperator, left: number, right: number): number {
  switch (operator) {
    case "add":
      return left + right;
    case "sub":
      return left - right;
    case "mul":
      return left * right;
    case "div":
      return left / right;
  }
}
