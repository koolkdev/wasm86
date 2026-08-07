import { notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { i32, i64, integer, nonzero, select, u8, unreachable } from "#compiler/function/values.js";
import { ValueScope } from "../scope.js";
import { Integer } from "../type.js";

test("constants expose normalized logical bits and signed i32 convenience values", () => {
  const values = new ValueScope();

  strictEqual(values.constantOf(integer(8, -1)), 0xffn);
  strictEqual(values.constValue(integer(8, -1)), 0xff);
  strictEqual(values.constantOf(i32(0xdead_beef)), 0xdead_beefn);
  strictEqual(values.constValue(i32(0xdead_beef)), -559_038_737);
  strictEqual(values.constantOf(i64(-1n)), 0xffff_ffff_ffff_ffffn);
  strictEqual(values.constValue(i64(-1n)), undefined);
});

test("constant binary operations fold modulo their logical width", () => {
  const values = new ValueScope();

  strictEqual(values.constantOf(u8(250).add(10)), 4n);
  strictEqual(values.constantOf(u8(0xf9).signed.div(2)), 0xfdn);
  strictEqual(values.constantOf(u8(0xff).unsigned.div(2)), 0x7fn);
  strictEqual(values.constantOf(u8(0x81).rotl(1)), 3n);
  strictEqual(values.constantOf(i64(0xffff_ffff_ffff_ffffn).add(1n)), 0n);
});

test("algebraic identities fold values on undefined arithmetic flows", () => {
  const values = new ValueScope();
  const dividend = values.parameter(0, Integer[32]);
  const divisor = values.parameter(1, Integer[32]);
  const division = dividend.unsigned.div(divisor);

  strictEqual(values.constantOf(division.mul(0)), 0n);
  strictEqual(values.constantOf(division.eq(division)), 1n);
  strictEqual(values.constantOf(select(nonzero(i32(1)), i32(0), division)), 0n);
});

test("signedness belongs to logical operators rather than stored values", () => {
  const values = new ValueScope();
  const allBits = u8(0xff);

  strictEqual(values.constantOf(allBits.signed.lt(1)), 1n);
  strictEqual(values.constantOf(allBits.unsigned.lt(1)), 0n);
  strictEqual(allBits.signed.lt(1).width, 1);
  strictEqual(allBits.unsigned.lt(1).width, 1);
});

test("truncation and extension fold as logical width changes", () => {
  const values = new ValueScope();
  const eighty = u8(0x80);

  strictEqual(values.constantOf(i32(-1).truncate(8)), 0xffn);
  strictEqual(values.constantOf(eighty.signed.extend(32)), 0xffff_ff80n);
  strictEqual(values.constValue(eighty.signed.extend(32)), -0x80);
  strictEqual(values.constantOf(eighty.unsigned.extend(32)), 0x80n);
  strictEqual(values.constantOf(eighty.signed.extend(64)), 0xffff_ffff_ffff_ff80n);
});

test("computed values derive one exact logical width", () => {
  const values = new ValueScope();
  const left = values.producer(Integer[8]);
  const right = values.producer(Integer[8]);
  const count = values.parameter(1, Integer[32]);
  const shifted = left.add(right).shl(count);
  const selected = select(nonzero(i32(1)), shifted, right);
  const countBits = selected.popcnt();

  for (const value of [shifted, selected, countBits]) {
    values.resolve(value);
    strictEqual(value.width, 8);
  }
  strictEqual(shifted.eq(right).width, 1);
});

test("scoped identities reuse ancestors without crossing sibling scopes", () => {
  const root = new ValueScope();
  const input = root.parameter(0, Integer[32]);
  const child = root.childScope();
  const ancestor = input.add(1);

  root.resolve(ancestor);
  strictEqual(child.sameValue(ancestor, input.add(1)), true);

  const left = input.xor(1);
  const right = input.xor(1);

  root.childScope().resolve(left);
  root.childScope().resolve(right);
  strictEqual(root.sameValue(left, right), false);
});

test("occurrence values retain their declared width and identity", () => {
  const values = new ValueScope();
  const first = values.producer(Integer[8]);
  const second = values.producer(Integer[8]);
  const loopInput = values.loopInput(Integer[16]);

  strictEqual(values.sameValue(first, second), false);
  strictEqual(first.width, 8);
  strictEqual(loopInput.width, 16);
});

test("typed unreachable values retain width through identity folds", () => {
  const values = new ValueScope();
  const byte = unreachable(8);
  const sum = byte.add(0);

  strictEqual(values.sameValue(byte, sum), true);
  strictEqual(sum.width, 8);
});

test("folded outcomes take the identity their literal equivalent takes", () => {
  const values = new ValueScope();

  strictEqual(values.sameValue(u8(2).add(3), u8(5)), true);
  strictEqual(values.sameValue(i32(1).unsigned.div(0), unreachable(32)), true);
  strictEqual(values.sameValue(u8(0xff).signed.extend(16), integer(16, 0xffff)), true);
  strictEqual(values.sameValue(integer(16, 0x1ff).truncate(8), u8(0xff)), true);
  notStrictEqual(values.constValue(u8(2).add(3)), undefined);
});
