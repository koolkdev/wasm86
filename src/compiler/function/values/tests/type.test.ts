import { equal } from "node:assert";
import { test } from "node:test";

import { f32 } from "../float/value.js";
import { Float, Integer, sameValueType, valueTypeOf } from "../type.js";

test("value types compare by kind and width", () => {
  const copiedByte = { ...Integer[8] };
  const copiedFloat = { ...Float[32] };

  equal(sameValueType(copiedByte, Integer[8]), true);
  equal(sameValueType(copiedByte, Integer[16]), false);
  equal(sameValueType(copiedFloat, Float[32]), true);
  equal(sameValueType(copiedFloat, Float[64]), false);
  equal(sameValueType(copiedFloat, Integer[32]), false);
  equal(valueTypeOf(f32(1)), Float[32]);
});
