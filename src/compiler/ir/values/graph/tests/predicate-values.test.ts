import { strictEqual } from "node:assert";
import { test } from "node:test";

import { ValueArena } from "../arena.js";
import { comparisonValue } from "../comparison.js";
import { constantValue, parameterValue } from "../leaves.js";
import { selectValue } from "../select.js";
import { zeroTestValue } from "../zero-test.js";

test("predicates occupy one logical bit", () => {
  const values = new ValueArena();
  const one = values.create(constantValue, { width: 32, value: 1 });
  const two = values.create(constantValue, { width: 32, value: 2 });
  const folded = values.create(comparisonValue, {
    operator: "lt_u",
    a: one,
    b: two
  });
  const input = values.create(parameterValue, { index: 0, width: 32 });
  const predicate = values.create(zeroTestValue, {
    operator: "nonzero",
    value: input
  });
  const selected = values.create(selectValue, {
    condition: predicate,
    whenTrue: one,
    whenFalse: two
  });

  strictEqual(values.bitWidth(folded), 1);
  strictEqual(values.constant(folded), 1n);
  strictEqual(values.bitWidth(predicate), 1);
  strictEqual(values.bitWidth(selected), 32);
});
