import { equal } from "node:assert";
import { test } from "node:test";

import { Integer, sameValueType } from "../type.js";

test("integer value types compare by width", () => {
  const copiedByte = { ...Integer[8] };

  equal(sameValueType(copiedByte, Integer[8]), true);
  equal(sameValueType(copiedByte, Integer[16]), false);
});
