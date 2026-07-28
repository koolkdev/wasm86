import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ValueTable } from "#compiler/ir/values/table.js";

test("i32 constants expose their canonical machine value", () => {
  const values = new ValueTable();

  strictEqual(values.constValue(values.const(7)), 7);
  strictEqual(values.constValue(values.const(0xdead_beef)), -559_038_737);
  strictEqual(values.valueType(values.const(7)), "i32");
  strictEqual(values.valueType(values.const64(7n)), "i64");
});

test("forks retain existing values and isolate later allocation", () => {
  const values = new ValueTable();
  const existing = values.const(7);
  const fork = values.fork();
  const forkOnly = fork.const(11);

  strictEqual(fork.constValue(existing), 7);
  strictEqual(fork.constValue(forkOnly), 11);
  throws(() => values.node(forkOnly), /unknown value id/);
});

test("value families report their scalar types and declared bounds", () => {
  const values = new ValueTable();
  const narrow = values.addNodeOutput({ unsignedBits: 8, signedBits: 9 });
  const wide = values.addNodeOutput64();
  const extended = values.extend64(32, narrow, false);
  const product = values.binary64("mul", extended, values.const64(3n));
  const compared = values.compare64("ne", product, values.const64(0n));

  strictEqual(values.valueType(narrow), "i32");
  deepStrictEqual(values.widthBounds(narrow), { unsignedBits: 8, signedBits: 9 });
  strictEqual(values.valueType(wide), "i64");
  strictEqual(values.valueType(product), "i64");
  strictEqual(values.valueType(compared), "i32");
  throws(() => values.widthBounds(wide), /i64 node output/);
});

test("unreachable values retain their result type and trap classification", () => {
  const values = new ValueTable();
  const unreachable32 = values.unreachable();
  const unreachable64 = values.unreachable("i64");

  strictEqual(values.isUnreachable(unreachable32), true);
  strictEqual(values.isUnreachable(unreachable64), true);
  strictEqual(values.valueType(unreachable32), "i32");
  strictEqual(values.valueType(unreachable64), "i64");
  strictEqual(values.captureMode(unreachable32), "reemit");
});

test("constant arithmetic folds to literal i32 results", () => {
  const values = new ValueTable();

  strictEqual(values.constValue(values.binary("add", values.const(1), values.const(2))), 3);
  strictEqual(
    values.constValue(values.binary("mul", values.const(0x4000_0000), values.const(2))),
    -2_147_483_648
  );
  strictEqual(values.constValue(values.binary("div_s", values.const(-7), values.const(2))), -3);
  strictEqual(
    values.constValue(values.binary("div_u", values.const(-1), values.const(2))),
    2_147_483_647
  );
  strictEqual(
    values.constValue(values.binary("rotl", values.const(0x1234_5678), values.const(8))),
    0x3456_7812
  );
});

test("constant unary, comparison, and width operations fold literally", () => {
  const values = new ValueTable();

  strictEqual(values.constValue(values.unary("popcnt", values.const(0xf0f0))), 8);
  strictEqual(values.constValue(values.unary("ctz", values.const(0x100))), 8);
  strictEqual(values.constValue(values.compare(32, "lt_s", values.const(-1), values.const(1))), 1);
  strictEqual(values.constValue(values.truncate(8, values.const(-1))), 0xff);
  strictEqual(values.constValue(values.extend(8, values.const(0x80), true)), -0x80);
});

test("division by zero folds to an unreachable value", () => {
  const values = new ValueTable();
  const quotient = values.binary("div_u", values.const(1), values.const(0));

  strictEqual(values.isUnreachable(quotient), true);
});

test("width bounds flow through bitwise operations and selections", () => {
  const values = new ValueTable();
  const condition = values.parameter(0, "i32");
  const byte = values.addNodeOutput({ unsignedBits: 8, signedBits: 9 });
  const masked = values.binary("and", values.addNodeOutput(), values.const(0xff));
  const selected = values.select(condition, byte, values.const(0x100));

  deepStrictEqual(values.widthBounds(masked), { unsignedBits: 8, signedBits: 9 });
  deepStrictEqual(values.widthBounds(selected), { unsignedBits: 9, signedBits: 10 });
});

test("nonconstant division reports whether it can trap", () => {
  const values = new ValueTable();
  const dividend = values.parameter(0, "i32");
  const dynamic = values.binary("div_u", dividend, values.parameter(1, "i32"));
  const safe = values.binary("div_u", dividend, values.const(17));
  const signedOverflow = values.binary("div_s", dividend, values.const(-1));

  strictEqual(values.mayTrap(dynamic), true);
  strictEqual(values.mayTrap(safe), false);
  strictEqual(values.mayTrap(signedOverflow), true);
});

test("typed operations reject operands from the wrong scalar universe", () => {
  const values = new ValueTable();
  const narrow = values.const(1);
  const wide = values.const64(1n);

  throws(() => values.binary("add", wide, narrow), /must be i32, got i64/);
  throws(() => values.binary64("mul", wide, narrow), /must be i64, got i32/);
  throws(() => values.extend64(32, wide, false), /must be i32, got i64/);
});
