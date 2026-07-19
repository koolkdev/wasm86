import { deepStrictEqual, notStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { BinaryOperator } from "#compiler/ir/values/binary.js";
import type { CompareOperator } from "#compiler/ir/values/comparison.js";
import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { ValueEmitContext } from "#compiler/ir/values/definition.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { UnaryOperator } from "#compiler/ir/values/unary.js";

test("value table deduplicates constants by canonical i32 value", () => {
  const table = new ValueTable();

  strictEqual(table.const(7), table.const(7));
  strictEqual(table.const(-1), table.const(0xffff_ffff));
  notStrictEqual(table.const(7), table.const(8));
  strictEqual(table.size(), 3);
});

test("value table exposes nodes by id", () => {
  const table = new ValueTable();
  const seven = table.const(7);
  const canonical = table.const(0xdeadbeef);

  strictEqual(table.constValue(seven), 7);
  strictEqual(table.constValue(canonical), 0xdeadbeef | 0);
  strictEqual(table.valueType(seven), "i32");
  throws(() => table.node(valueId(99)), /unknown value id 99/);
});

test("value table forks preserve the prefix and isolate later allocation", () => {
  const table = new ValueTable();
  const constant = table.const(7);
  const input = table.addNodeOutput(fitsUnsigned(8));
  const sum = table.binary("add", input, constant);
  const wide = table.const64(9n);

  // Populate a derived cache before forking as well as the immutable graph.
  deepStrictEqual(table.widthBounds(input), fitsUnsigned(8));
  const parentSize = table.size();
  const fork = table.fork();

  strictEqual(fork.size(), parentSize);
  strictEqual(fork.node(sum), table.node(sum));
  deepStrictEqual(fork.children(sum), table.children(sum));
  strictEqual(fork.constValue(constant), 7);
  strictEqual(fork.valueType(input), "i32");
  strictEqual(fork.valueType(wide), "i64");
  deepStrictEqual(fork.widthBounds(input), fitsUnsigned(8));
  strictEqual(fork.const(7), constant, "the copied interning trie retains prefix ids");
  strictEqual(fork.binary("add", input, constant), sum);

  const forkOnly = fork.const(11);
  fork.addNodeOutput();
  strictEqual(table.size(), parentSize, "fork allocations do not mutate the parent");
  const parentOnly = table.const(11);

  strictEqual(table.constValue(parentOnly), 11);
  strictEqual(fork.constValue(forkOnly), 11);
  strictEqual(table.size(), parentSize + 1);
  const laterParentOnly = table.const(13);

  strictEqual(table.constValue(laterParentOnly), 13);
  strictEqual(fork.constValue(fork.const(13)), 13);
  strictEqual(table.const(7), constant, "fork interning does not mutate the parent trie");
});

test("node outputs retain their declared scalar type", () => {
  const table = new ValueTable();
  const narrow = table.addNodeOutput();
  const wide = table.addNodeOutput64();

  strictEqual(table.valueType(narrow), "i32");
  strictEqual(table.valueType(wide), "i64");
  throws(() => table.widthBounds(wide), /i64 node output/);
});

test("unreachable values re-emit but retain their semantic identity", () => {
  const table = new ValueTable();
  const unreachable = table.unreachable();

  strictEqual(table.captureMode(unreachable), "reemit");
  strictEqual(table.isUnreachable(unreachable), true);
  strictEqual(table.isUnreachable(table.const(0)), false);
});

test("building the same expression twice yields the same node id", () => {
  const table = new ValueTable();
  const a = table.addNodeOutput();
  const b = table.external(0);
  const add = table.binary("add", a, b);

  strictEqual(table.binary("add", a, b), add);
  notStrictEqual(table.binary("add", b, a), add);
  notStrictEqual(table.binary("sub", a, b), add);
  strictEqual(table.valueType(add), "i32");
});

test("multiply expressions intern and fold as i32 low products", () => {
  const table = new ValueTable();
  const a = table.addNodeOutput();
  const b = table.external(0);
  const product = table.binary("mul", a, b);

  strictEqual(table.binary("mul", a, b), product);
  strictEqual(table.valueType(product), "i32");
  strictEqual(table.binary("mul", table.const(0x7fff_ffff), table.const(2)), table.const(-2));
  strictEqual(table.binary("mul", a, table.const(1)), a);
  strictEqual(table.binary("mul", table.const(0), b), table.const(0));
});

test("signed right shift is a distinct binary operator", () => {
  const table = new ValueTable();
  const a = table.addNodeOutput();
  const b = table.const(2);
  const shifted = table.binary("shr_s", a, b);

  strictEqual(table.binary("shr_s", a, b), shifted);
  notStrictEqual(table.binary("shr_u", a, b), shifted);
});

test("each compound kind deduplicates on its full key", () => {
  const table = new ValueTable();
  const a = table.addNodeOutput();
  const b = table.external(0);

  const extend = table.extend(8, a, true);

  strictEqual(table.extend(8, a, true), extend);
  notStrictEqual(table.unary("popcnt", a), extend);
  notStrictEqual(table.extend(16, a, true), extend);
  notStrictEqual(table.extend(8, a, false), extend);
  strictEqual(table.valueType(extend), "i32");

  const compare = table.compare(32, "eq", a, b);

  strictEqual(table.compare(32, "eq", a, b), compare);
  notStrictEqual(table.compare(32, "ne", a, b), compare);
  strictEqual(table.valueType(compare), "i32");

  const select = table.select(compare, a, b);

  strictEqual(table.select(compare, a, b), select);
  notStrictEqual(table.select(compare, b, a), select);

  const truncate = table.truncate(16, a);

  strictEqual(table.truncate(16, a), truncate);
  notStrictEqual(table.truncate(8, a), truncate);
});

test("i64 values deduplicate on their typed operation keys", () => {
  const table = new ValueTable();
  const a = table.addNodeOutput();
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
  const notEqual = table.compare64("ne", product, extendedA);

  for (const [value, type] of [
    [a, "i32"],
    [extendedA, "i64"],
    [zeroExtendedA, "i64"],
    [product, "i64"],
    [quotient, "i64"],
    [remainder, "i64"],
    [shift, "i64"],
    [high, "i64"],
    [low, "i32"],
    [notEqual, "i32"]
  ] as const) {
    strictEqual(table.valueType(value), type);
  }
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
  const value = table.addNodeOutput();
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
  const value = table.addNodeOutput();
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
  const a = table.addNodeOutput();
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
  const value = table.addNodeOutput();

  strictEqual(table.widthAdjusted(8, value, true), table.extend(8, value, true));
  strictEqual(table.widthAdjusted(8, value, false), table.truncate(8, value));
  strictEqual(table.widthAdjusted(32, value, false), value);
});

test("select folds constant conditions and equal arms", () => {
  const table = new ValueTable();
  const condition = table.addNodeOutput();
  const value = table.addNodeOutput();
  const fallback = table.external(0);

  strictEqual(table.select(table.const(1), value, fallback), value);
  strictEqual(table.select(table.const(-1), value, fallback), value);
  strictEqual(table.select(table.const(0), value, fallback), fallback);
  strictEqual(table.select(condition, value, value), value);
});

test("node outputs are distinct leaves, never deduped", () => {
  const table = new ValueTable();
  const first = table.addNodeOutput();
  const second = table.addNodeOutput();

  notStrictEqual(first, second);
  strictEqual(table.valueType(first), "i32");
  strictEqual(table.valueType(second), "i32");
});

test("external leaves deduplicate by external id", () => {
  const table = new ValueTable();

  strictEqual(table.external(3), table.external(3));
  notStrictEqual(table.external(3), table.external(4));
  strictEqual(table.valueType(table.external(3)), "i32");
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

test("truncate64 folds matching signed and unsigned extensions", () => {
  const table = new ValueTable();
  const source = table.addNodeOutput();
  const low16 = table.truncate(16, source);

  strictEqual(table.node(low16).kind, "truncate");
  strictEqual(table.truncate64(16, table.extend64(16, source, true)), low16);
  strictEqual(table.truncate64(16, table.extend64(16, source, false)), low16);
});

test("compare results fit a single bit either way", () => {
  const table = new ValueTable();
  const compare = table.compare(32, "eq", table.addNodeOutput(), table.external(0));
  const wide = table.extend64(32, table.addNodeOutput(), true);
  const product = table.binary64("mul", wide, table.extend64(32, table.external(1), true));
  const i64Compare = table.compare64("ne", wide, product);

  strictEqual(table.truncate(8, compare), compare);
  strictEqual(table.extend(8, compare, true), compare);
  strictEqual(table.truncate(8, i64Compare), i64Compare);
  strictEqual(table.extend(8, i64Compare, true), i64Compare);
});

test("truncations and extensions cover follow-up requests they imply", () => {
  const table = new ValueTable();
  const unproven = table.addNodeOutput();
  const low8 = table.truncate(8, unproven);

  // An 8-bit truncation fits unsigned 16 and is sign-extended from 9 bits up.
  strictEqual(table.truncate(16, low8), low8);
  strictEqual(table.extend(16, low8, true), low8);
  strictEqual(table.node(table.extend(8, low8, true)).kind, "extend");

  const extended = table.extend(8, unproven, true);

  strictEqual(table.extend(16, extended, true), extended);
  strictEqual(table.node(table.truncate(8, extended)).kind, "truncate");
});

test("node outputs carry their declared bounds", () => {
  const table = new ValueTable();
  const byteRead = table.addNodeOutput(fitsUnsigned(8));

  strictEqual(table.truncate(8, byteRead), byteRead);
  strictEqual(table.node(table.extend(8, byteRead, true)).kind, "extend");

  const signedRead = table.addNodeOutput(signExtended(8));

  strictEqual(table.extend(8, signedRead, true), signedRead);
  strictEqual(table.extend(16, signedRead, true), signedRead);
  strictEqual(table.node(table.truncate(8, signedRead)).kind, "truncate");

  const opaque = table.addNodeOutput();

  strictEqual(table.node(table.truncate(8, opaque)).kind, "truncate");
  strictEqual(table.node(table.extend(8, opaque, true)).kind, "extend");
});

test("unbounded results stay wrapped", () => {
  const table = new ValueTable();
  const sum = table.binary("add", table.addNodeOutput(), table.const(2));
  const byte = table.addNodeOutput(fitsUnsigned(8));
  const signedShift = table.binary("shr_s", byte, table.const(2));

  strictEqual(table.node(table.truncate(8, sum)).kind, "truncate");
  strictEqual(table.node(table.extend(16, sum, true)).kind, "extend");
  strictEqual(table.node(table.truncate(8, signedShift)).kind, "truncate");
  strictEqual(table.node(table.extend(16, signedShift, true)).kind, "extend");
});

test("bitwise results inherit their operands' bounds", () => {
  const table = new ValueTable();
  const opaque = table.addNodeOutput();
  const byte = table.addNodeOutput(fitsUnsigned(8));

  const masked = table.binary("and", opaque, table.const(0xff));

  strictEqual(table.truncate(8, masked), masked);

  const mixed = table.binary("or", byte, table.const(0x0f));

  strictEqual(table.truncate(8, mixed), mixed);
  strictEqual(table.node(table.truncate(8, table.binary("or", byte, opaque))).kind, "truncate");

  const shifted = table.binary("shr_u", byte, opaque);

  strictEqual(table.truncate(8, shifted), shifted);

  const topBit = table.binary("shr_u", byte, table.const(7));

  deepStrictEqual(table.widthBounds(topBit), fitsUnsigned(1));

  // not al: xor with -1 keeps sign extension.
  const signedByte = table.addNodeOutput(signExtended(8));
  const inverted = table.binary("xor", signedByte, table.const(-1));

  strictEqual(table.extend(8, inverted, true), inverted);
  strictEqual(table.node(table.truncate(8, inverted)).kind, "truncate");
});

test("a select is bounded by the weaker of its arms", () => {
  const table = new ValueTable();
  const condition = table.addNodeOutput();
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
  strictEqual(table.truncate(8, second), second);
  strictEqual(table.node(table.truncate(8, first)).kind, "truncate");
});

test("value inputs preserve repeated uses exactly", () => {
  const table = new ValueTable();
  const value = table.addNodeOutput();
  const doubled = table.binary("add", value, value);
  const emitted: ValueId[] = [];

  strictEqual(table.valueType(doubled), "i32");
  table.emit(doubled, {
    body: new WasmFunctionBodyEncoder(),
    emitUse: (input) => emitted.push(input),
    emitNodeOutput: () => {},
    emitExternal: () => {},
    emitParameter: () => {},
    emitLoopInput: () => {}
  });
  deepStrictEqual(emitted, [value, value]);
});

test("emission visits stored inputs once in their declared order", () => {
  const table = new ValueTable();
  const condition = table.external(0);
  const whenTrue = table.addNodeOutput();
  const whenFalse = table.addNodeOutput();
  const selected = table.select(condition, whenTrue, whenFalse);
  const emitted: ValueId[] = [];

  table.emit(selected, {
    body: new WasmFunctionBodyEncoder(),
    emitUse: (value) => emitted.push(value),
    emitNodeOutput: () => {},
    emitExternal: () => {},
    emitParameter: () => {},
    emitLoopInput: () => {}
  });

  deepStrictEqual(emitted, [whenTrue, whenFalse, condition]);
});

test("select joins arm bounds", () => {
  const table = new ValueTable();
  const condition = table.external(0);
  const whenTrue = table.addNodeOutput(fitsUnsigned(1));
  const whenFalse = table.addNodeOutput(fitsUnsigned(8));
  const selected = table.select(condition, whenTrue, whenFalse);

  strictEqual(table.valueType(selected), "i32");
  deepStrictEqual(table.widthBounds(selected), fitsUnsigned(8));
});

test("division trap detection uses i32 and i64 constants", () => {
  const table = new ValueTable();
  const dividend32 = table.addNodeOutput();
  const minusOne32 = table.const(-1);
  const zero32 = table.const(0);
  const seventeen32 = table.const(17);
  const min64 = table.const64(-0x8000_0000_0000_0000n);
  const one64 = table.const64(1n);
  const minusOne64 = table.const64(-1n);
  const zero64 = table.const64(0n);
  const seventeen64 = table.const64(17n);

  for (const operator of ["div_s", "div_u", "rem_s", "rem_u"] as const) {
    const zeroDivisor32 = table.binary(operator, dividend32, zero32);
    const safeDivisor32 = table.binary(operator, dividend32, seventeen32);
    const zeroDivisor64 = table.binary64(operator, one64, zero64);
    const safeDivisor64 = table.binary64(operator, one64, seventeen64);

    strictEqual(table.node(zeroDivisor32).kind, "binary");
    strictEqual(table.node(safeDivisor32).kind, "binary");
    strictEqual(table.node(zeroDivisor64).kind, "binary");
    strictEqual(table.node(safeDivisor64).kind, "binary");
    strictEqual(table.mayTrap(zeroDivisor32), true);
    strictEqual(table.mayTrap(safeDivisor32), false);
    strictEqual(table.mayTrap(zeroDivisor64), true);
    strictEqual(table.mayTrap(safeDivisor64), false);
  }

  const possibleOverflow32 = table.binary("div_s", dividend32, minusOne32);
  const exactOverflow64 = table.binary64("div_s", min64, minusOne64);
  const safeMinusOne64 = table.binary64("div_s", one64, minusOne64);

  strictEqual(table.node(possibleOverflow32).kind, "binary");
  strictEqual(table.node(exactOverflow64).kind, "binary");
  strictEqual(table.node(safeMinusOne64).kind, "binary");
  strictEqual(table.mayTrap(possibleOverflow32), true);
  strictEqual(table.mayTrap(exactOverflow64), true);
  strictEqual(table.mayTrap(safeMinusOne64), false);
});

test("every scalar operator constructs and realizes its supported value types", () => {
  const table = new ValueTable();
  const a = table.addNodeOutput();
  const b = table.external(0);
  const a64 = table.extend64(32, a, true);
  const b64 = table.extend64(32, b, true);
  const body = new WasmFunctionBodyEncoder();
  const emitContext: ValueEmitContext = {
    body,
    emitUse: () => {},
    emitNodeOutput: () => {},
    emitExternal: () => {},
    emitParameter: () => {},
    emitLoopInput: () => {}
  };

  for (const operator of binaryOperators) {
    const value32 = table.binary(operator, a, b);
    const value64 = table.binary64(operator, a64, b64);

    strictEqual(table.valueType(value32), "i32", operator);
    strictEqual(table.valueType(value64), "i64", operator);
    table.emit(value32, emitContext);
    table.emit(value64, emitContext);
  }

  for (const operator of unaryOperators) {
    const value = table.unary(operator, a);

    strictEqual(table.valueType(value), "i32", operator);
    table.emit(value, emitContext);
  }

  for (const operator of compareOperators) {
    const value32 = table.compare(32, operator, a, b);
    const value64 = table.compare64(operator, a64, b64);

    strictEqual(table.valueType(value32), "i32", operator);
    strictEqual(table.valueType(value64), "i32", operator);
    table.emit(value32, emitContext);
    table.emit(value64, emitContext);
  }
});

const binaryOperators: readonly BinaryOperator[] = [
  "add", "sub", "mul", "div_s", "div_u", "rem_s", "rem_u", "xor", "or", "and",
  "shl", "rotl", "rotr", "shr_s", "shr_u"
];
const unaryOperators: readonly UnaryOperator[] = ["popcnt", "ctz", "clz", "eqz"];
const compareOperators: readonly CompareOperator[] = [
  "eq", "ne", "lt_u", "le_u", "gt_u", "ge_u", "lt_s", "le_s", "gt_s", "ge_s"
];
