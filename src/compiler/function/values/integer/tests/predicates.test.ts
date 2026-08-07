import { strictEqual } from "node:assert";
import { test } from "node:test";

import { i32, nonzero, select } from "#compiler/function/values.js";
import { ValueScope } from "../../scope.js";
import { Integer } from "../../type.js";

test("predicates occupy one logical bit", () => {
  const values = new ValueScope();
  const folded = i32(1).unsigned.lt(2);
  const input = values.parameter(0, Integer[32]);
  const predicate = nonzero(input);
  const selected = select(predicate, i32(1), i32(2));

  strictEqual(folded.width, 1);
  strictEqual(values.constantOf(folded), 1n);
  strictEqual(predicate.width, 1);
  strictEqual(selected.width, 32);
});
