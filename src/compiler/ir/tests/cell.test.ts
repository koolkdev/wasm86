import { notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { CellRef } from "#compiler/ir/cell.js";

test("every cell has a fresh opaque identity", () => {
  const first = new CellRef("i32");
  const second = new CellRef("i32");

  notStrictEqual(first, second);
  notStrictEqual(first, new CellRef("i64"));
});

test("a cell exposes its value type", () => {
  const cell = new CellRef("i64");

  strictEqual(cell.kind, "cell");
  strictEqual(cell.type, "i64");
});
