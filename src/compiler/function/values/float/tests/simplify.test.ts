import { strictEqual } from "node:assert";
import { test } from "node:test";

import { f32, f64, integer, type ValueRef } from "#compiler/function/values.js";
import { ValueResolver } from "../../resolver.js";
import { Float } from "../../type.js";

test("constant float expressions simplify from their IEEE bits", () => {
  const values = new ValueResolver();
  const cases: readonly (readonly [string, ValueRef, ValueRef])[] = [
    ["f32 arithmetic", f32(-1).mul(0), f32(-0)],
    ["f64 arithmetic", f64(1.5).add(2.25), f64(3.75)],
    ["comparison", f32(Number.NaN).ne(0), integer(1, 1)]
  ];

  for (const [name, actual, expected] of cases) {
    strictEqual(values.sameValue(actual, expected), true, name);
  }
});

test("float simplification preserves IEEE-dependent operations", () => {
  const values = new ValueResolver();
  const value = values.producer(Float[32]);

  strictEqual(values.sameValue(value.eq(value), integer(1, 0)), false);
  strictEqual(values.sameValue(value.eq(value), integer(1, 1)), false);
  strictEqual(values.sameValue(value.add(0), value), false);
  strictEqual(values.sameValue(value.sub(value), f32(0)), false);
  strictEqual(values.resolve(f32(0).div(0)).expression.op, "float.binary");
});
