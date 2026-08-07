import { equal, notEqual } from "node:assert";
import { test } from "node:test";

import { Integer, sameValueType } from "../type.js";

test("integer value types compare by width", () => {
  const copied = { ...Integer[32] };

  notEqual(copied, Integer[32]);
  equal(sameValueType(copied, Integer[32]), true);
  equal(sameValueType(copied, Integer[64]), false);
});
