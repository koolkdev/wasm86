import { strictEqual } from "node:assert";
import { test } from "node:test";

import { integer, i8, i32, i64, nonzero, select, u8, unreachable } from "#compiler/ir/values.js";
import { ValueTable } from "../../graph/table.js";

test("full-width values share one integer operation model", () => {
  const values = new ValueTable();
  const cases = [
    [i32(7).xor(8).shl(5), 480],
    [i32(7).add(5), 12],
    [i32(7).sub(5), 2],
    [i32(-3).mul(7), -21],
    [i32(-7).signed.div(2), -3],
    [i32(-1).unsigned.div(2), 0x7fff_ffff],
    [i32(-7).signed.rem(4), -3],
    [i32(-1).unsigned.rem(16), 15],
    [i32(0b1100).and(0b1010), 0b1000],
    [i32(0b1100).or(0b1010), 0b1110],
    [i32(-8).unsigned.shr(1), 0x7fff_fffc],
    [i32(-8).signed.shr(1), -4],
    [i32(0x1234_5678).rotl(8), 0x3456_7812],
    [i32(0x1234_5678).rotr(8), 0x7812_3456],
    [i32(0xf0f0).popcnt(), 8],
    [i32(0x100).ctz(), 8],
    [i32(1).clz(), 31],
    [i32(0).eqz(), 1],
    [i32(7).eq(7), 1],
    [i32(7).ne(7), 0],
    [nonzero(i32(0)), 0],
    [nonzero(i32(1)), 1],
    [select(nonzero(i32(0)), i32(11), i32(22)), 22],
    [select(nonzero(i32(1)), i32(11), i32(22)), 11]
  ] as const;

  for (const [value, expected] of cases) {
    strictEqual(values.constValue(values.use(value)), expected);
  }
});

test("narrow values use logical-width operations", () => {
  const values = new ValueTable();
  const byte = u8(0xff);
  const cases = [
    [byte.add(2), 1],
    [byte.eq(0xff), 1],
    [byte.eq(-1), 1],
    [byte.signed.lt(0), 1],
    [byte.unsigned.lt(0), 0],
    [byte.unsigned.lt(-1), 0],
    [u8(5).unsigned.div(0x101), 5],
    [u8(5).unsigned.rem(0x102), 1],
    [byte.signed.extend(16), 0xffff],
    [byte.unsigned.extend(16), 0xff],
    [u8(0).ctz(), 8],
    [u8(0).clz(), 8],
    [u8(1).clz(), 7],
    [u8(0x80).msb(), 1],
    [u8(0x10).bit(4), 1],
    [u8(0x81).rotl(1), 3],
    [u8(0x81).rotr(1), 0xc0],
    [select(nonzero(i32(1)), byte, u8(1)), 0xff],
    [select(nonzero(i32(0)), byte, u8(0x101)), 1]
  ] as const;

  for (const [value, expected] of cases) {
    strictEqual(values.constValue(values.use(value)), expected);
  }
});

test("narrow operations ignore carrier bits above their logical width", () => {
  const values = new ValueTable();
  const zero = i32(0x100).truncate(8);
  const negative = i32(0x180).truncate(8);
  const cases = [
    [zero.eqz(), 1],
    [zero.eq(0), 1],
    [zero.unsigned.shr(1), 0],
    [zero.popcnt(), 0],
    [zero.ctz(), 8],
    [negative.signed.lt(0), 1],
    [negative.unsigned.lt(0), 0],
    [negative.signed.shr(1), 0xc0],
    [negative.unsigned.shr(1), 0x40],
    [negative.rotl(1), 1]
  ] as const;

  for (const [value, expected] of cases) {
    strictEqual(values.constValue(values.use(value)), expected);
  }
});

test("integer constructs constants from a dynamic width", () => {
  const values = new ValueTable();
  const cases: readonly (readonly [width: 8 | 16, value: number, expected: number])[] = [
    [8, 0x101, 1],
    [16, 0x1_0002, 2]
  ];

  for (const [width, value, expected] of cases) {
    strictEqual(values.constValue(values.use(integer(width, value))), expected);
  }
});

test("signed narrow division wraps overflow at its logical width", () => {
  const values = new ValueTable();
  const quotient = values.use(i8(-0x80).signed.div(-1));

  strictEqual(values.isUnreachable(quotient), false);
  strictEqual(values.constValue(quotient), 0x80);
});

test("narrow division sees a wrapped zero literal", () => {
  const values = new ValueTable();
  const division = u8(5).unsigned.div(0x100);

  strictEqual(values.isUnreachable(values.use(division)), true);
});

test("i64 has the same operation surface as i32", () => {
  const values = new ValueTable();
  const count = u8(5);
  const expressions = [
    i64(7n).xor(8n).shl(count),
    i64(-8n).signed.shr(1),
    i64(-1n).unsigned.div(2n),
    i64(-7n).signed.rem(4n),
    i64(0xf0f0n).popcnt(),
    i64(0x100n).ctz(),
    i64(1n).clz(),
    i64(0n).eqz(),
    i64(-1n).signed.lt(0n),
    i64(-1n).unsigned.gt(0n),
    i8(-1).signed.extend(64),
    i64(0x1ffn).truncate(8)
  ] as const;

  for (const expression of expressions) {
    values.use(expression);
  }

  strictEqual(values.bitWidth(values.use(expressions[0])), 64);
  strictEqual(values.bitWidth(values.use(expressions[7])), 1);
  strictEqual(values.bitWidth(values.use(expressions[8])), 1);
  strictEqual(values.bitWidth(values.use(expressions[9])), 1);
  strictEqual(values.bitWidth(values.use(expressions[10])), 64);
  strictEqual(values.bitWidth(values.use(expressions[11])), 8);
});

test("unreachable values preserve their bit width", () => {
  const values = new ValueTable();
  const byte = values.use(unreachable(8));
  const dword = values.use(unreachable());
  const qword = values.use(unreachable(64));

  strictEqual(values.bitWidth(byte), 8);
  strictEqual(values.bitWidth(dword), 32);
  strictEqual(values.bitWidth(qword), 64);
  strictEqual(values.isUnreachable(byte), true);
  strictEqual(values.isUnreachable(dword), true);
  strictEqual(values.isUnreachable(qword), true);
});
