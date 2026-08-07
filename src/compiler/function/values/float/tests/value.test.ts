import { strictEqual } from "node:assert";
import { test } from "node:test";

import { Float } from "#compiler/function/type.js";
import { ValueScope } from "#compiler/function/values/scope.js";
import { f32, f64, i32 } from "#compiler/function/values.js";

test("float identity is its exact bit pattern", () => {
  const values = new ValueScope();

  strictEqual(values.sameValue(f32(1).add(2), f32(3)), true);
  strictEqual(values.sameValue(f64(1).mul(4), f64(4)), true);
  strictEqual(values.sameValue(f32(1).div(0), f32(Number.POSITIVE_INFINITY)), true);
  strictEqual(values.sameValue(f32(0.5), f64(0.5)), false);
  strictEqual(values.sameValue(f32(0), f32(-0)), false);
  strictEqual(values.sameValue(f32(-0), f32(-0)), true);
  strictEqual(values.sameValue(f32(0).div(0), f32(Number.NaN)), false);
});

test("float comparisons fold from their operands", () => {
  const values = new ValueScope();

  strictEqual(values.sameValue(f32(2).lt(3), i32(1).truncate(1)), true);
  strictEqual(values.sameValue(f32(Number.NaN).eq(1), i32(0).truncate(1)), true);
  // Decoding a negative operand at the Integer[1] result width, or ordering by
  // its bit pattern, would fold these comparisons incorrectly.
  strictEqual(values.sameValue(f32(-2).lt(1), i32(1).truncate(1)), true);
  strictEqual(values.sameValue(f64(-2).ge(-3), i32(1).truncate(1)), true);

  // NaN is not equal to itself, so integer identity folding must not reach a
  // float comparison merely because both operands are one value.
  const parameter = values.parameter(0, Float[32]);

  strictEqual(values.sameValue(parameter.eq(parameter), i32(1).truncate(1)), false);
});
