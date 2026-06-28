import { deepStrictEqual, notStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ValueTable, fitsUnsigned, signExtended } from "#ir/values.js";

test("value table deduplicates constants by canonical i32 value", () => {
  const table = new ValueTable();

  strictEqual(table.const(7), table.const(7));
  strictEqual(table.const(-1), table.const(0xffff_ffff));
  notStrictEqual(table.const(7), table.const(8));
  strictEqual(table.size(), 3);
});

test("value table exposes nodes by id", () => {
  const table = new ValueTable();

  deepStrictEqual(table.node(table.const(7)), { kind: "const", value: 7 });
  deepStrictEqual(table.node(table.const(0xdeadbeef)), { kind: "const", value: 0xdeadbeef | 0 });
  throws(() => table.node(99), /unknown value id 99/);
});

test("building the same expression twice yields the same node id", () => {
  const table = new ValueTable();
  const a = table.addActionOutput();
  const b = table.external(0);
  const add = table.binary("add", a, b);

  strictEqual(table.binary("add", a, b), add);
  notStrictEqual(table.binary("add", b, a), add);
  notStrictEqual(table.binary("sub", a, b), add);
  deepStrictEqual(table.node(add), { kind: "binary", operator: "add", a, b });
});

test("signed right shift is a distinct binary operator", () => {
  const table = new ValueTable();
  const a = table.addActionOutput();
  const b = table.const(2);
  const shifted = table.binary("shr_s", a, b);

  strictEqual(table.binary("shr_s", a, b), shifted);
  notStrictEqual(table.binary("shr_u", a, b), shifted);
  deepStrictEqual(table.node(shifted), { kind: "binary", operator: "shr_s", a, b });
});

test("each compound kind deduplicates on its full key", () => {
  const table = new ValueTable();
  const a = table.addActionOutput();
  const b = table.external(0);

  const extend = table.unary("extend8_s", a);

  strictEqual(table.unary("extend8_s", a), extend);
  notStrictEqual(table.unary("popcnt", a), extend);
  deepStrictEqual(table.node(extend), { kind: "unary", operator: "extend8_s", value: a });

  const compare = table.compare("eq", a, b);

  strictEqual(table.compare("eq", a, b), compare);
  notStrictEqual(table.compare("ne", a, b), compare);
  deepStrictEqual(table.node(compare), { kind: "compare", operator: "eq", a, b });

  const select = table.select(compare, a, b);

  strictEqual(table.select(compare, a, b), select);
  notStrictEqual(table.select(compare, b, a), select);
  deepStrictEqual(table.node(select), { kind: "select", condition: compare, whenTrue: a, whenFalse: b });

  const project = table.project(16, a);

  strictEqual(table.project(16, a), project);
  notStrictEqual(table.project(8, a), project);
  deepStrictEqual(table.node(project), { kind: "project", width: 16, value: a });
});

test("binary operations fold constant operands", () => {
  const table = new ValueTable();
  const one = table.const(1);
  const two = table.const(2);
  const minusOne = table.const(-1);

  strictEqual(table.binary("add", one, two), table.const(3));
  strictEqual(table.binary("sub", one, two), table.const(-1));
  strictEqual(table.binary("xor", minusOne, table.const(0xff)), table.const(-0x100));
  strictEqual(table.binary("or", table.const(0x100), table.const(0xff)), table.const(0x1ff));
  strictEqual(table.binary("and", table.const(0x1ff), table.const(0xff)), table.const(0xff));
  strictEqual(table.binary("shl", one, table.const(32)), one);
  strictEqual(table.binary("shl", one, table.const(33)), two);
  strictEqual(table.binary("shr_s", table.const(-4), one), table.const(-2));
  strictEqual(table.binary("shr_u", table.const(-4), one), table.const(0x7fff_fffe));
});

test("binary operations fold local identities", () => {
  const table = new ValueTable();
  const value = table.addActionOutput();
  const zero = table.const(0);
  const minusOne = table.const(-1);

  strictEqual(table.binary("add", value, zero), value);
  strictEqual(table.binary("add", zero, value), value);
  strictEqual(table.binary("sub", value, zero), value);
  strictEqual(table.binary("sub", value, value), zero);
  strictEqual(table.binary("xor", value, zero), value);
  strictEqual(table.binary("xor", zero, value), value);
  strictEqual(table.binary("xor", value, value), zero);
  strictEqual(table.binary("or", value, zero), value);
  strictEqual(table.binary("or", zero, value), value);
  strictEqual(table.binary("or", value, value), value);
  strictEqual(table.binary("or", value, minusOne), minusOne);
  strictEqual(table.binary("and", value, minusOne), value);
  strictEqual(table.binary("and", minusOne, value), value);
  strictEqual(table.binary("and", value, zero), zero);
  strictEqual(table.binary("and", value, value), value);
  strictEqual(table.binary("shl", value, zero), value);
  strictEqual(table.binary("shr_s", value, zero), value);
  strictEqual(table.binary("shr_u", value, zero), value);
  strictEqual(table.binary("shr_u", zero, value), zero);
});

test("unary operations fold constants", () => {
  const table = new ValueTable();

  strictEqual(table.unary("extend8_s", table.const(0x80)), table.const(-0x80));
  strictEqual(table.unary("extend16_s", table.const(0x8000)), table.const(-0x8000));
  strictEqual(table.unary("popcnt", table.const(0xf0f0)), table.const(8));
});

test("compares fold constants and same-value predicates", () => {
  const table = new ValueTable();
  const value = table.addActionOutput();
  const one = table.const(1);
  const two = table.const(2);
  const minusOne = table.const(-1);

  strictEqual(table.compare("eq", one, one), table.const(1));
  strictEqual(table.compare("ne", one, one), table.const(0));
  strictEqual(table.compare("lt_u", minusOne, one), table.const(0));
  strictEqual(table.compare("gt_u", minusOne, one), table.const(1));
  strictEqual(table.compare("lt_s", minusOne, one), table.const(1));
  strictEqual(table.compare("ge_s", one, two), table.const(0));
  strictEqual(table.compare("le_u", value, value), table.const(1));
  strictEqual(table.compare("gt_s", value, value), table.const(0));
});

test("select folds constant conditions and equal arms", () => {
  const table = new ValueTable();
  const condition = table.addActionOutput();
  const value = table.addActionOutput();
  const fallback = table.external(0);

  strictEqual(table.select(table.const(1), value, fallback), value);
  strictEqual(table.select(table.const(-1), value, fallback), value);
  strictEqual(table.select(table.const(0), value, fallback), fallback);
  strictEqual(table.select(condition, value, value), value);
});

test("action outputs are distinct leaves, never deduped", () => {
  const table = new ValueTable();
  const first = table.addActionOutput();
  const second = table.addActionOutput();

  notStrictEqual(first, second);
  deepStrictEqual(table.node(first), { kind: "actionOutput" });
  deepStrictEqual(table.node(second), { kind: "actionOutput" });
});

test("external leaves deduplicate by external id", () => {
  const table = new ValueTable();

  strictEqual(table.external(3), table.external(3));
  notStrictEqual(table.external(3), table.external(4));
  deepStrictEqual(table.node(table.external(3)), { kind: "external", external: 3 });
});

test("compound nodes reject unknown children", () => {
  const table = new ValueTable();
  const a = table.const(1);

  throws(() => table.binary("add", a, 99), /unknown value id 99/);
  throws(() => table.unary("popcnt", 99), /unknown value id 99/);
  throws(() => table.select(99, a, a), /unknown value id 99/);
  throws(() => table.project(8, 99), /unknown value id 99/);
  throws(() => table.extend(8, 99), /unknown value id 99/);
});

test("project folds constants and elides projections covered by bounds", () => {
  const table = new ValueTable();

  strictEqual(table.project(8, table.const(0xff)), table.const(0xff));
  strictEqual(table.project(16, table.const(0xffff)), table.const(0xffff));
  strictEqual(table.project(32, table.const(-1)), table.const(-1));
  strictEqual(table.project(8, table.const(0x100)), table.const(0));
  strictEqual(table.project(8, table.const(-1)), table.const(0xff));
  strictEqual(table.project(16, table.const(-1)), table.const(0xffff));
});

test("extend folds constants and elides extensions covered by bounds", () => {
  const table = new ValueTable();

  strictEqual(table.extend(8, table.const(127)), table.const(127));
  strictEqual(table.extend(8, table.const(-128)), table.const(-128));
  strictEqual(table.extend(32, table.const(0x12345678)), table.const(0x12345678));
  strictEqual(table.extend(8, table.const(128)), table.const(-128));
  strictEqual(table.extend(8, table.const(-129)), table.const(127));
  strictEqual(table.extend(16, table.const(0x8000)), table.const(-0x8000));
});

test("compare results fit a single bit either way", () => {
  const table = new ValueTable();
  const compare = table.compare("eq", table.addActionOutput(), table.external(0));

  strictEqual(table.project(8, compare), compare);
  strictEqual(table.extend(8, compare), compare);
});

test("projections and extensions cover follow-up requests they imply", () => {
  const table = new ValueTable();
  const unproven = table.addActionOutput();
  const low8 = table.project(8, unproven);

  // An 8-bit projection fits unsigned 16 and is sign-extended from 9 bits up.
  strictEqual(table.project(16, low8), low8);
  strictEqual(table.extend(16, low8), low8);
  strictEqual(table.node(table.extend(8, low8)).kind, "unary");

  const extended = table.unary("extend8_s", unproven);

  strictEqual(table.extend(16, extended), extended);
  strictEqual(table.node(table.project(8, extended)).kind, "project");
});

test("action outputs carry their declared bounds", () => {
  const table = new ValueTable();
  const byteRead = table.addActionOutput(fitsUnsigned(8));

  strictEqual(table.project(8, byteRead), byteRead);
  strictEqual(table.node(table.extend(8, byteRead)).kind, "unary");

  const signedRead = table.addActionOutput(signExtended(8));

  strictEqual(table.extend(8, signedRead), signedRead);
  strictEqual(table.extend(16, signedRead), signedRead);
  strictEqual(table.node(table.project(8, signedRead)).kind, "project");

  const opaque = table.addActionOutput();

  strictEqual(table.node(table.project(8, opaque)).kind, "project");
  strictEqual(table.node(table.extend(8, opaque)).kind, "unary");
});

test("unbounded results stay wrapped", () => {
  const table = new ValueTable();
  const sum = table.binary("add", table.addActionOutput(), table.const(2));
  const byte = table.addActionOutput(fitsUnsigned(8));
  const signedShift = table.binary("shr_s", byte, table.const(2));

  strictEqual(table.node(table.project(8, sum)).kind, "project");
  strictEqual(table.node(table.extend(16, sum)).kind, "unary");
  strictEqual(table.node(table.project(8, signedShift)).kind, "project");
  strictEqual(table.node(table.extend(16, signedShift)).kind, "unary");
});

test("bitwise results inherit their operands' bounds", () => {
  const table = new ValueTable();
  const opaque = table.addActionOutput();
  const byte = table.addActionOutput(fitsUnsigned(8));

  const masked = table.binary("and", opaque, table.const(0xff));

  strictEqual(table.project(8, masked), masked);

  const mixed = table.binary("or", byte, table.const(0x0f));

  strictEqual(table.project(8, mixed), mixed);
  strictEqual(table.node(table.project(8, table.binary("or", byte, opaque))).kind, "project");

  const shifted = table.binary("shr_u", byte, opaque);

  strictEqual(table.project(8, shifted), shifted);

  // not al: xor with -1 keeps sign extension.
  const signedByte = table.addActionOutput(signExtended(8));
  const inverted = table.binary("xor", signedByte, table.const(-1));

  strictEqual(table.extend(8, inverted), inverted);
  strictEqual(table.node(table.project(8, inverted)).kind, "project");
});

test("a select is bounded by the weaker of its arms", () => {
  const table = new ValueTable();
  const condition = table.addActionOutput();
  const bit = table.select(condition, table.const(1), table.const(0));

  strictEqual(table.project(8, bit), bit);
  strictEqual(table.extend(8, bit), bit);

  const wide = table.select(condition, table.const(1), table.const(0x100));

  strictEqual(table.node(table.project(8, wide)).kind, "project");
});
