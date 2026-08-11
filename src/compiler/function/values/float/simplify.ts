import { assert } from "#common/assert.js";
import type { FloatExpression, ValueRef } from "#compiler/function/values/expression.js";
import type { ValueResolution } from "#compiler/function/values/resolver.js";
import { integerConstant } from "../integer/value.js";
import { evaluateBinary, evaluateComparison } from "./evaluate.js";
import { floatConstantBits } from "./value.js";

type FloatOperation = Extract<FloatExpression, { op: "float.binary" | "float.compare" }>;

export function simplifyFloat(
  expression: FloatOperation,
  a: ValueResolution | undefined,
  b: ValueResolution | undefined
): ValueRef | undefined {
  const left = floatConstantBitsOf(a);
  const right = floatConstantBitsOf(b);

  if (left === undefined || right === undefined) {
    return undefined;
  }

  switch (expression.op) {
    case "float.binary":
      switch (expression.width) {
        case 32: {
          assert(typeof left === "number" && typeof right === "number", "invalid f32 constants");
          const result = evaluateBinary(expression.attr, 32, left, right);

          return result === undefined ? undefined : floatConstantBits(32, result);
        }
        case 64: {
          assert(typeof left === "bigint" && typeof right === "bigint", "invalid f64 constants");
          const result = evaluateBinary(expression.attr, 64, left, right);

          return result === undefined ? undefined : floatConstantBits(64, result);
        }
      }
    case "float.compare":
      switch (expression.a.width) {
        case 32:
          assert(typeof left === "number" && typeof right === "number", "invalid f32 constants");
          return integerConstant(1, evaluateComparison(expression.attr, 32, left, right) ? 1n : 0n);
        case 64:
          assert(typeof left === "bigint" && typeof right === "bigint", "invalid f64 constants");
          return integerConstant(1, evaluateComparison(expression.attr, 64, left, right) ? 1n : 0n);
      }
  }
}

function floatConstantBitsOf(resolution: ValueResolution | undefined): number | bigint | undefined {
  const expression = resolution?.expression;

  return expression?.op === "float.constant" ? expression.attr : undefined;
}
