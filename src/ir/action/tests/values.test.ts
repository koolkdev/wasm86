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

test("building the same expression twice yields the same node id", () => {
  const table = createValueTable();
  const a = table.internConst(1);
  const b = table.internConst(2);
  const add = table.internBinary("add", a, b);

  strictEqual(table.internBinary("add", a, b), add);
  notStrictEqual(table.internBinary("add", b, a), add);
  notStrictEqual(table.internBinary("sub", a, b), add);
  deepStrictEqual(table.node(add), { kind: "binary", operator: "add", a, b });
});

test("each compound kind interns on its full key", () => {
  const table = createValueTable();
  const a = table.internConst(1);
  const b = table.internConst(2);

  const extend = table.internUnary("extend8_s", a);

  strictEqual(table.internUnary("extend8_s", a), extend);
  notStrictEqual(table.internUnary("popcnt", a), extend);
  deepStrictEqual(table.node(extend), { kind: "unary", operator: "extend8_s", value: a });

  const compare = table.internCompare(32, "eq", a, b);

  strictEqual(table.internCompare(32, "eq", a, b), compare);
  notStrictEqual(table.internCompare(16, "eq", a, b), compare);
  notStrictEqual(table.internCompare(32, "ne", a, b), compare);
  deepStrictEqual(table.node(compare), { kind: "compare", width: 32, operator: "eq", a, b });

  const select = table.internSelect(compare, a, b);

  strictEqual(table.internSelect(compare, a, b), select);
  notStrictEqual(table.internSelect(compare, b, a), select);
  deepStrictEqual(table.node(select), { kind: "select", condition: compare, whenTrue: a, whenFalse: b });

  const project = table.internProject(16, a);

  strictEqual(table.internProject(16, a), project);
  notStrictEqual(table.internProject(8, a), project);
  deepStrictEqual(table.node(project), { kind: "project", width: 16, value: a });
});

test("action outputs are distinct leaves, never deduped", () => {
  const table = createValueTable();
  const first = table.addActionOutput();
  const second = table.addActionOutput();

  notStrictEqual(first, second);
  deepStrictEqual(table.node(first), { kind: "actionOutput" });
  deepStrictEqual(table.node(second), { kind: "actionOutput" });
});

test("external leaves intern by external id", () => {
  const table = createValueTable();

  strictEqual(table.internExternal(3), table.internExternal(3));
  notStrictEqual(table.internExternal(3), table.internExternal(4));
  deepStrictEqual(table.node(table.internExternal(3)), { kind: "external", external: 3 });
});

test("use counts reflect graph edges, not interning hits", () => {
  const table = createValueTable();
  const a = table.internConst(1);
  const b = table.internConst(2);
  const add = table.internBinary("add", a, b);

  strictEqual(table.useCount(a), 1);
  strictEqual(table.useCount(b), 1);

  table.internBinary("add", a, b);
  strictEqual(table.useCount(a), 1);

  const doubled = table.internBinary("add", add, add);

  strictEqual(table.useCount(add), 2);
  strictEqual(table.useCount(doubled), 0);
  throws(() => table.useCount(99), /unknown value id 99/);
});

test("compound nodes reject unknown children", () => {
  const table = createValueTable();
  const a = table.internConst(1);

  throws(() => table.internBinary("add", a, 99), /unknown value id 99/);
  throws(() => table.internUnary("popcnt", 99), /unknown value id 99/);
  throws(() => table.internSelect(99, a, a), /unknown value id 99/);
});
