import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { CellRef } from "#compiler/ir/cell.js";

test("every cell has a fresh opaque identity", () => {
  const first = new CellRef("i32");
  const second = new CellRef("i32");

  notStrictEqual(first, second);
  notStrictEqual(first, new CellRef("i64"));
});

test("a cell carries its type and nothing else", () => {
  const cell = new CellRef("i64");

  strictEqual(cell.kind, "cell");
  strictEqual(cell.type, "i64");
  // No numbering, no scope metadata: scope is derived structurally from the
  // seed site, so identity is the object itself.
  deepStrictEqual(Reflect.ownKeys(cell).sort(), ["kind", "type"]);
});
