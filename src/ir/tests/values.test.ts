import { deepStrictEqual, notStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ValueTable } from "#ir/value-table.js";
import { fitsUnsigned, signExtended, valueChildren, valueId } from "#ir/values.js";

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
  throws(() => table.node(valueId(99)), /unknown value id 99/);
});

test("building the same expression twice yields the same node id", () => {
  const table = new ValueTable();
  const a = table.addActionOutput();
  const b = table.external(0);
  const add = table.binary("add", a, b);

  strictEqual(table.binary("add", a, b), add);
  notStrictEqual(table.binary("add", b, a), add);
  notStrictEqual(table.binary("sub", a, b), add);
  deepStrictEqual(table.node(add), { kind: "binary", type: "i32", operator: "add", a, b });
});

test("multiply expressions intern and fold as i32 low products", () => {
  const table = new ValueTable();
  const a = table.addActionOutput();
  const b = table.external(0);
  const product = table.binary("mul", a, b);

  strictEqual(table.binary("mul", a, b), product);
  deepStrictEqual(table.node(product), { kind: "binary", type: "i32", operator: "mul", a, b });
  strictEqual(table.binary("mul", table.const(0x7fff_ffff), table.const(2)), table.const(-2));
  strictEqual(table.binary("mul", a, table.const(1)), a);
  strictEqual(table.binary("mul", table.const(0), b), table.const(0));
});

test("signed right shift is a distinct binary operator", () => {
  const table = new ValueTable();
  const a = table.addActionOutput();
  const b = table.const(2);
  const shifted = table.binary("shr_s", a, b);

  strictEqual(table.binary("shr_s", a, b), shifted);
  notStrictEqual(table.binary("shr_u", a, b), shifted);
  deepStrictEqual(table.node(shifted), { kind: "binary", type: "i32", operator: "shr_s", a, b });
});

test("each compound kind deduplicates on its full key", () => {
  const table = new ValueTable();
  const a = table.addActionOutput();
  const b = table.external(0);

  const extend = table.extend(8, a, true);

  strictEqual(table.extend(8, a, true), extend);
  notStrictEqual(table.unary("popcnt", a), extend);
  notStrictEqual(table.extend(16, a, true), extend);
  notStrictEqual(table.extend(8, a, false), extend);
  deepStrictEqual(table.node(extend), { kind: "extend", type: "i32", signed: true, width: 8, value: a });

  const compare = table.compare(32, "eq", a, b);

  strictEqual(table.compare(32, "eq", a, b), compare);
  notStrictEqual(table.compare(32, "ne", a, b), compare);
  deepStrictEqual(table.node(compare), { kind: "compare", type: "i32", operator: "eq", a, b });

  const select = table.select(compare, a, b);

  strictEqual(table.select(compare, a, b), select);
  notStrictEqual(table.select(compare, b, a), select);
  deepStrictEqual(table.node(select), { kind: "select", condition: compare, whenTrue: a, whenFalse: b });

  const truncate = table.truncate(16, a);

  strictEqual(table.truncate(16, a), truncate);
  notStrictEqual(table.truncate(8, a), truncate);
  deepStrictEqual(table.node(truncate), { kind: "truncate", sourceType: "i32", width: 16, value: a });
});

test("i64 values deduplicate on their typed operation keys", () => {
  const table = new ValueTable();
  const a = table.addActionOutput();
  const b = table.external(0);
  const extendedA = table.extend64(32, a, true);
  const extendedB = table.extend64(32, b, true);
  const zeroExtendedA = table.extend64(32, a, false);
  const product = table.binary64("mul", extendedA, extendedB);
  const quotient = table.binary64("div_s", extendedA, extendedB);
  const remainder = table.binary64("rem_s", zeroExtendedA, table.extend64(32, b, false));
  const shift = table.const64(32n);
  const high = table.binary64("shr_u", product, shift);
  const low = table.truncate64(32, product);
  const low16 = table.truncate64(16, product);
  const notEqual = table.compare64("ne", product, extendedA);

  strictEqual(table.valueType(a), "i32");
  strictEqual(table.valueType(extendedA), "i64");
  strictEqual(table.valueType(zeroExtendedA), "i64");
  strictEqual(table.valueType(product), "i64");
  strictEqual(table.valueType(quotient), "i64");
  strictEqual(table.valueType(remainder), "i64");
  strictEqual(table.valueType(shift), "i64");
  strictEqual(table.valueType(high), "i64");
  strictEqual(table.valueType(low), "i32");
  strictEqual(table.valueType(notEqual), "i32");
  strictEqual(table.extend64(32, a, true), extendedA);
  strictEqual(table.extend64(32, a, false), zeroExtendedA);
  strictEqual(table.binary64("mul", extendedA, extendedB), product);
  strictEqual(table.binary64("div_s", extendedA, extendedB), quotient);
  strictEqual(table.binary64("rem_s", zeroExtendedA, table.extend64(32, b, false)), remainder);
  strictEqual(table.binary64("shr_u", product, shift), high);
  strictEqual(table.const64(32n), shift);
  strictEqual(table.const64(-0x8000_0000_0000_0000n), table.const64(0x8000_0000_0000_0000n));
  notStrictEqual(table.const64(32n), table.const(32));
  notStrictEqual(table.binary64("mul", extendedB, extendedA), product);
  notStrictEqual(table.extend64(16, a, false), zeroExtendedA);
  notStrictEqual(table.extend64(32, a, false), extendedA);
  strictEqual(table.truncate64(32, product), low);
  notStrictEqual(table.truncate64(16, product), low);
  strictEqual(table.compare64("ne", product, extendedA), notEqual);
  notStrictEqual(table.compare64("ne", extendedA, product), notEqual);
  strictEqual(table.compare64("eq", product, product), table.const(1));
  strictEqual(table.compare64("ne", product, product), table.const(0));
  strictEqual(table.truncate64(32, extendedA), a);
  strictEqual(table.truncate64(32, zeroExtendedA), a);

  deepStrictEqual(table.node(extendedA), { kind: "extend", type: "i64", signed: true, width: 32, value: a });
  deepStrictEqual(table.node(zeroExtendedA), { kind: "extend", type: "i64", signed: false, width: 32, value: a });
  deepStrictEqual(table.node(product), { kind: "binary", type: "i64", operator: "mul", a: extendedA, b: extendedB });
  deepStrictEqual(table.node(quotient), { kind: "binary", type: "i64", operator: "div_s", a: extendedA, b: extendedB });
  deepStrictEqual(table.node(remainder), { kind: "binary", type: "i64", operator: "rem_s", a: zeroExtendedA, b: table.extend64(32, b, false) });
  deepStrictEqual(table.node(shift), { kind: "const64", value: 32n });
  deepStrictEqual(table.node(table.const64(-1n)), { kind: "const64", value: -1n });
  deepStrictEqual(table.node(high), { kind: "binary", type: "i64", operator: "shr_u", a: product, b: shift });
  deepStrictEqual(table.node(low), { kind: "truncate", sourceType: "i64", width: 32, value: product });
  deepStrictEqual(table.node(low16), { kind: "truncate", sourceType: "i64", width: 16, value: product });
  deepStrictEqual(table.node(notEqual), { kind: "compare", type: "i64", operator: "ne", a: product, b: extendedA });
});

test("binary operations fold constant operands", () => {
  const table = new ValueTable();
  const one = table.const(1);
  const two = table.const(2);
  const minusOne = table.const(-1);

  strictEqual(table.binary("add", one, two), table.const(3));
  strictEqual(table.binary("sub", one, two), table.const(-1));
  strictEqual(table.binary("mul", table.const(0x4000_0000), two), table.const(0x8000_0000));
  strictEqual(table.binary("div_s", table.const(-7), two), table.const(-3));
  strictEqual(table.binary("div_u", table.const(-1), table.const(2)), table.const(0x7fff_ffff));
  strictEqual(table.binary("rem_s", table.const(-7), two), table.const(-1));
  strictEqual(table.binary("rem_u", table.const(31), table.const(9)), table.const(4));
  strictEqual(table.binary("rem_u", table.const(-1), table.const(10)), table.const(5));
  strictEqual(table.node(table.binary("div_s", table.const(1), table.const(0))).kind, "unreachable");
  strictEqual(table.node(table.binary("rem_s", table.const(1), table.const(0))).kind, "unreachable");
  strictEqual(table.node(table.binary("div_s", table.const(-0x8000_0000), table.const(-1))).kind, "unreachable");
  strictEqual(table.node(table.binary("div_u", table.const(1), table.const(0))).kind, "unreachable");
  strictEqual(table.node(table.binary("rem_u", table.const(1), table.const(0))).kind, "unreachable");
  strictEqual(table.binary("rotl", table.const(0x1234_5678), table.const(8)), table.const(0x3456_7812));
  strictEqual(table.binary("rotr", table.const(0x1234_5678), table.const(8)), table.const(0x7812_3456));
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
  strictEqual(table.binary("rem_u", value, table.const(1)), zero);
  strictEqual(table.binary("rem_s", value, table.const(1)), zero);
  strictEqual(table.binary("rem_s", value, table.const(-1)), zero);
  strictEqual(table.node(table.binary("rem_u", zero, value)).kind, "binary");
  strictEqual(table.node(table.binary("rem_u", value, zero)).kind, "binary");
  strictEqual(table.binary("shl", value, zero), value);
  strictEqual(table.binary("rotl", value, zero), value);
  strictEqual(table.binary("rotr", value, zero), value);
  strictEqual(table.binary("rotl", zero, value), zero);
  strictEqual(table.binary("rotr", zero, value), zero);
  strictEqual(table.binary("shr_s", value, zero), value);
  strictEqual(table.binary("shr_u", value, zero), value);
  strictEqual(table.binary("shr_u", zero, value), zero);
});

test("unary operations fold constants", () => {
  const table = new ValueTable();

  strictEqual(table.unary("popcnt", table.const(0xf0f0)), table.const(8));
  strictEqual(table.unary("ctz", table.const(0x0100)), table.const(8));
  strictEqual(table.unary("ctz", table.const(0)), table.const(32));
  strictEqual(table.unary("clz", table.const(0x0100)), table.const(23));
  strictEqual(table.unary("clz", table.const(0)), table.const(32));
});

test("extend folds constants", () => {
  const table = new ValueTable();

  strictEqual(table.extend(8, table.const(0x80), true), table.const(-0x80));
  strictEqual(table.extend(16, table.const(0x8000), true), table.const(-0x8000));
  strictEqual(table.extend(8, table.const(0xff), false), table.const(0xff));
  strictEqual(table.extend(8, table.const(-1), false), table.const(0xff));
});

test("compares fold constants and same-value predicates", () => {
  const table = new ValueTable();
  const value = table.addActionOutput();
  const one = table.const(1);
  const two = table.const(2);
  const minusOne = table.const(-1);

  strictEqual(table.compare(32, "eq", one, one), table.const(1));
  strictEqual(table.compare(32, "ne", one, one), table.const(0));
  strictEqual(table.compare(32, "lt_u", minusOne, one), table.const(0));
  strictEqual(table.compare(32, "gt_u", minusOne, one), table.const(1));
  strictEqual(table.compare(32, "lt_s", minusOne, one), table.const(1));
  strictEqual(table.compare(32, "ge_s", one, two), table.const(0));
  strictEqual(table.compare(32, "le_u", value, value), table.const(1));
  strictEqual(table.compare(32, "gt_s", value, value), table.const(0));
});

test("compare lowers narrow widths by predicate class", () => {
  const table = new ValueTable();
  const a = table.addActionOutput();
  const b = table.external(0);

  strictEqual(
    table.compare(16, "lt_s", a, b),
    table.compare(32, "lt_s", table.extend(16, a, true), table.extend(16, b, true))
  );
  strictEqual(
    table.compare(8, "eq", a, b),
    table.compare(32, "eq", table.truncate(8, a), table.truncate(8, b))
  );
});

test("widthAdjusted extends when signed and truncates otherwise", () => {
  const table = new ValueTable();
  const value = table.addActionOutput();

  strictEqual(table.widthAdjusted(8, value, true), table.extend(8, value, true));
  strictEqual(table.widthAdjusted(8, value, false), table.truncate(8, value));
  strictEqual(table.widthAdjusted(32, value, false), value);
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
  const wide = table.extend64(32, a, true);
  const unknown = valueId(99);

  throws(() => table.binary("add", a, unknown), /unknown value id 99/);
  throws(() => table.unary("popcnt", unknown), /unknown value id 99/);
  throws(() => table.select(unknown, a, a), /unknown value id 99/);
  throws(() => table.truncate(8, unknown), /unknown value id 99/);
  throws(() => table.extend(8, unknown, true), /unknown value id 99/);
  throws(() => table.extend64(32, unknown, true), /unknown value id 99/);
  throws(() => table.extend64(32, unknown, false), /unknown value id 99/);
  throws(() => table.binary64("mul", wide, unknown), /unknown value id 99/);
  throws(() => table.truncate64(32, unknown), /unknown value id 99/);
  throws(() => table.binary("add", wide, a), /value \d+ must be i32, got i64/);
  throws(() => table.truncate(8, wide), /value \d+ must be i32, got i64/);
  throws(() => table.binary64("mul", wide, a), /value \d+ must be i64, got i32/);
  throws(() => table.binary64("shr_u", wide, a), /value \d+ must be i64, got i32/);
  throws(() => table.compare64("ne", wide, a), /value \d+ must be i64, got i32/);
  throws(() => table.truncate64(32, a), /value \d+ must be i64, got i32/);
  throws(() => table.extend64(32, wide, true), /value \d+ must be i32, got i64/);
  throws(() => table.extend64(32, wide, false), /value \d+ must be i32, got i64/);
});

test("truncate folds constants and elides truncations covered by bounds", () => {
  const table = new ValueTable();

  strictEqual(table.truncate(8, table.const(0xff)), table.const(0xff));
  strictEqual(table.truncate(16, table.const(0xffff)), table.const(0xffff));
  strictEqual(table.truncate(32, table.const(-1)), table.const(-1));
  strictEqual(table.truncate(8, table.const(0x100)), table.const(0));
  strictEqual(table.truncate(8, table.const(-1)), table.const(0xff));
  strictEqual(table.truncate(16, table.const(-1)), table.const(0xffff));
});

test("extend folds constants and elides extensions covered by bounds", () => {
  const table = new ValueTable();

  strictEqual(table.extend(8, table.const(127), true), table.const(127));
  strictEqual(table.extend(8, table.const(-128), true), table.const(-128));
  strictEqual(table.extend(32, table.const(0x12345678), true), table.const(0x12345678));
  strictEqual(table.extend(8, table.const(128), true), table.const(-128));
  strictEqual(table.extend(8, table.const(-129), true), table.const(127));
  strictEqual(table.extend(16, table.const(0x8000), true), table.const(-0x8000));
});

test("compare results fit a single bit either way", () => {
  const table = new ValueTable();
  const compare = table.compare(32, "eq", table.addActionOutput(), table.external(0));
  const wide = table.extend64(32, table.addActionOutput(), true);
  const product = table.binary64("mul", wide, table.extend64(32, table.external(1), true));
  const i64Compare = table.compare64("ne", wide, product);

  strictEqual(table.truncate(8, compare), compare);
  strictEqual(table.extend(8, compare, true), compare);
  strictEqual(table.truncate(8, i64Compare), i64Compare);
  strictEqual(table.extend(8, i64Compare, true), i64Compare);
});

test("truncations and extensions cover follow-up requests they imply", () => {
  const table = new ValueTable();
  const unproven = table.addActionOutput();
  const low8 = table.truncate(8, unproven);

  // An 8-bit truncation fits unsigned 16 and is sign-extended from 9 bits up.
  strictEqual(table.truncate(16, low8), low8);
  strictEqual(table.extend(16, low8, true), low8);
  strictEqual(table.node(table.extend(8, low8, true)).kind, "extend");

  const extended = table.extend(8, unproven, true);

  strictEqual(table.extend(16, extended, true), extended);
  strictEqual(table.node(table.truncate(8, extended)).kind, "truncate");
});

test("action outputs carry their declared bounds", () => {
  const table = new ValueTable();
  const byteRead = table.addActionOutput(fitsUnsigned(8));

  strictEqual(table.truncate(8, byteRead), byteRead);
  strictEqual(table.node(table.extend(8, byteRead, true)).kind, "extend");

  const signedRead = table.addActionOutput(signExtended(8));

  strictEqual(table.extend(8, signedRead, true), signedRead);
  strictEqual(table.extend(16, signedRead, true), signedRead);
  strictEqual(table.node(table.truncate(8, signedRead)).kind, "truncate");

  const opaque = table.addActionOutput();

  strictEqual(table.node(table.truncate(8, opaque)).kind, "truncate");
  strictEqual(table.node(table.extend(8, opaque, true)).kind, "extend");
});

test("unbounded results stay wrapped", () => {
  const table = new ValueTable();
  const sum = table.binary("add", table.addActionOutput(), table.const(2));
  const byte = table.addActionOutput(fitsUnsigned(8));
  const signedShift = table.binary("shr_s", byte, table.const(2));

  strictEqual(table.node(table.truncate(8, sum)).kind, "truncate");
  strictEqual(table.node(table.extend(16, sum, true)).kind, "extend");
  strictEqual(table.node(table.truncate(8, signedShift)).kind, "truncate");
  strictEqual(table.node(table.extend(16, signedShift, true)).kind, "extend");
});

test("bitwise results inherit their operands' bounds", () => {
  const table = new ValueTable();
  const opaque = table.addActionOutput();
  const byte = table.addActionOutput(fitsUnsigned(8));

  const masked = table.binary("and", opaque, table.const(0xff));

  strictEqual(table.truncate(8, masked), masked);

  const mixed = table.binary("or", byte, table.const(0x0f));

  strictEqual(table.truncate(8, mixed), mixed);
  strictEqual(table.node(table.truncate(8, table.binary("or", byte, opaque))).kind, "truncate");

  const shifted = table.binary("shr_u", byte, opaque);

  strictEqual(table.truncate(8, shifted), shifted);

  // not al: xor with -1 keeps sign extension.
  const signedByte = table.addActionOutput(signExtended(8));
  const inverted = table.binary("xor", signedByte, table.const(-1));

  strictEqual(table.extend(8, inverted, true), inverted);
  strictEqual(table.node(table.truncate(8, inverted)).kind, "truncate");
});

test("a select is bounded by the weaker of its arms", () => {
  const table = new ValueTable();
  const condition = table.addActionOutput();
  const bit = table.select(condition, table.const(1), table.const(0));

  strictEqual(table.truncate(8, bit), bit);
  strictEqual(table.extend(8, bit, true), bit);

  const wide = table.select(condition, table.const(1), table.const(0x100));

  strictEqual(table.node(table.truncate(8, wide)).kind, "truncate");
});

test("loop inputs are opaque i32 leaves with their creation bounds", () => {
  const table = new ValueTable();
  const first = table.addLoopInput();
  const second = table.addLoopInput(fitsUnsigned(8));

  notStrictEqual(first, second);
  strictEqual(table.node(first).kind, "loopInput");
  strictEqual(table.valueType(first), "i32");
  deepStrictEqual(valueChildren(table.node(first)), []);
  strictEqual(table.truncate(8, second), second);
  strictEqual(table.node(table.truncate(8, first)).kind, "truncate");
});
