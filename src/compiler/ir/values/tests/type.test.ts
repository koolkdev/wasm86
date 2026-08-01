import { strictEqual } from "node:assert";
import { test } from "node:test";

import { Integer, sameValueType, u8, valueTypeOf } from "#compiler/ir/values.js";

test("integer types preserve exact logical widths", () => {
  strictEqual(Integer[8].kind, "integer");
  strictEqual(Integer[8].width, 8);
  strictEqual(sameValueType(Integer[8], { ...Integer[8] }), true);
  strictEqual(sameValueType(Integer[8], Integer[16]), false);
  strictEqual(valueTypeOf(u8(0)), Integer[8]);
});
