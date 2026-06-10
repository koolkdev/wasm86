import { deepStrictEqual, notStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createValueTable, fitsUnsigned, signExtended } from "#ir/action/values.js";

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

  const compare = table.internCompare("eq", a, b);

  strictEqual(table.internCompare("eq", a, b), compare);
  notStrictEqual(table.internCompare("ne", a, b), compare);
  deepStrictEqual(table.node(compare), { kind: "compare", operator: "eq", a, b });

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

test("projectTo elides projections covered by constant bounds", () => {
  const table = createValueTable();

  strictEqual(table.projectTo(8, table.internConst(0xff)), table.internConst(0xff));
  strictEqual(table.projectTo(16, table.internConst(0xffff)), table.internConst(0xffff));
  strictEqual(table.projectTo(32, table.internConst(-1)), table.internConst(-1));

  const wide = table.projectTo(8, table.internConst(0x100));

  deepStrictEqual(table.node(wide), { kind: "project", width: 8, value: table.internConst(0x100) });
  deepStrictEqual(table.node(table.projectTo(8, table.internConst(-1))).kind, "project");
});

test("extendTo elides extensions covered by constant bounds", () => {
  const table = createValueTable();

  strictEqual(table.extendTo(8, table.internConst(127)), table.internConst(127));
  strictEqual(table.extendTo(8, table.internConst(-128)), table.internConst(-128));
  strictEqual(table.extendTo(32, table.internConst(0x12345678)), table.internConst(0x12345678));

  deepStrictEqual(table.node(table.extendTo(8, table.internConst(128))), {
    kind: "unary",
    operator: "extend8_s",
    value: table.internConst(128)
  });
  deepStrictEqual(table.node(table.extendTo(8, table.internConst(-129))).kind, "unary");
});

test("compare results fit a single bit either way", () => {
  const table = createValueTable();
  const compare = table.internCompare("eq", table.internConst(1), table.internConst(2));

  strictEqual(table.projectTo(8, compare), compare);
  strictEqual(table.extendTo(8, compare), compare);
});

test("projections and extensions cover follow-up requests they imply", () => {
  const table = createValueTable();
  const unproven = table.addActionOutput();
  const low8 = table.internProject(8, unproven);

  // An 8-bit projection fits unsigned 16 and is sign-extended from 9 bits up.
  strictEqual(table.projectTo(16, low8), low8);
  strictEqual(table.extendTo(16, low8), low8);
  strictEqual(table.node(table.extendTo(8, low8)).kind, "unary");

  const extended = table.internUnary("extend8_s", unproven);

  strictEqual(table.extendTo(16, extended), extended);
  strictEqual(table.node(table.projectTo(8, extended)).kind, "project");
});

test("action outputs carry their declared bounds", () => {
  const table = createValueTable();
  const byteRead = table.addActionOutput(fitsUnsigned(8));

  strictEqual(table.projectTo(8, byteRead), byteRead);
  strictEqual(table.node(table.extendTo(8, byteRead)).kind, "unary");

  const signedRead = table.addActionOutput(signExtended(8));

  strictEqual(table.extendTo(8, signedRead), signedRead);
  strictEqual(table.extendTo(16, signedRead), signedRead);
  strictEqual(table.node(table.projectTo(8, signedRead)).kind, "project");

  const opaque = table.addActionOutput();

  strictEqual(table.node(table.projectTo(8, opaque)).kind, "project");
  strictEqual(table.node(table.extendTo(8, opaque)).kind, "unary");
});

test("unbounded results stay wrapped", () => {
  const table = createValueTable();
  const sum = table.internBinary("add", table.internConst(1), table.internConst(2));

  strictEqual(table.node(table.projectTo(8, sum)).kind, "project");
  strictEqual(table.node(table.extendTo(16, sum)).kind, "unary");
});

test("bitwise results inherit their operands' bounds", () => {
  const table = createValueTable();
  const opaque = table.addActionOutput();
  const byte = table.addActionOutput(fitsUnsigned(8));

  const masked = table.internBinary("and", opaque, table.internConst(0xff));

  strictEqual(table.projectTo(8, masked), masked);

  const mixed = table.internBinary("or", byte, table.internConst(0x0f));

  strictEqual(table.projectTo(8, mixed), mixed);
  strictEqual(table.node(table.projectTo(8, table.internBinary("or", byte, opaque))).kind, "project");

  const shifted = table.internBinary("shr_u", byte, opaque);

  strictEqual(table.projectTo(8, shifted), shifted);

  // not al: xor with -1 keeps sign extension.
  const signedByte = table.addActionOutput(signExtended(8));
  const inverted = table.internBinary("xor", signedByte, table.internConst(-1));

  strictEqual(table.extendTo(8, inverted), inverted);
  strictEqual(table.node(table.projectTo(8, inverted)).kind, "project");
});

test("a select is bounded by the weaker of its arms", () => {
  const table = createValueTable();
  const condition = table.addActionOutput();
  const bit = table.internSelect(condition, table.internConst(1), table.internConst(0));

  strictEqual(table.projectTo(8, bit), bit);
  strictEqual(table.extendTo(8, bit), bit);

  const wide = table.internSelect(condition, table.internConst(1), table.internConst(0x100));

  strictEqual(table.node(table.projectTo(8, wide)).kind, "project");
});
