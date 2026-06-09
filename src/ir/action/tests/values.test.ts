import { deepStrictEqual, notStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createValueTable } from "#ir/action/values.js";

test("value table interns constants by canonical i32 value", () => {
  const table = createValueTable();

  strictEqual(table.internConst(7), table.internConst(7));
  strictEqual(table.internConst(-1), table.internConst(0xffff_ffff));
  notStrictEqual(table.internConst(7), table.internConst(8));
  strictEqual(table.size(), 3);
});

test("value table exposes interned nodes by id", () => {
  const table = createValueTable();

  deepStrictEqual(table.node(table.internConst(7)), { kind: "const", value: 7 });
  deepStrictEqual(table.node(table.internConst(0xdeadbeef)), { kind: "const", value: 0xdeadbeef | 0 });
  throws(() => table.node(99), /unknown value id 99/);
});
