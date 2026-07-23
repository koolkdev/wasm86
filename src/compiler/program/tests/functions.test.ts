import { notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { functionType } from "#compiler/ir/function.js";
import { FunctionFamily } from "#compiler/program/functions.js";

const noEffects = { reads: [], writes: [] } as const;

test("function families provide one stable definition for each key", () => {
  const family = new FunctionFamily<number>({
    type: functionType([], []),
    effects: () => noEffects,
    id: (key) => `test.family.${key}`,
    build: (_key, fn) => fn.return([])
  });

  const first = family.get(1);

  strictEqual(family.get(1), first);
  notStrictEqual(family.get(2), first);
  strictEqual(first.ref.id, "test.family.1");
});
