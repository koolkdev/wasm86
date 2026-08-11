import { strictEqual } from "node:assert";
import { test } from "node:test";

import { i32, integer, nonzero, u8, type ValueRef } from "#compiler/function/values.js";
import { ValueResolver } from "../../resolver.js";
import { Integer } from "../../type.js";

test("constant integer expressions simplify to literal values", () => {
  const values = new ValueResolver();
  const cases: readonly (readonly [string, ValueRef, ValueRef])[] = [
    ["binary", u8(0xfa).add(10), u8(4)],
    ["comparison", u8(0xff).signed.lt(1), integer(1, 1)],
    ["zero test", u8(0).eqz(), integer(1, 1)],
    ["bit count", u8(0xf0).popcnt(), u8(4)],
    ["extension", u8(0x80).signed.extend(32), i32(-128)],
    ["truncation", i32(0x1ff).truncate(8), u8(0xff)]
  ];

  for (const [name, actual, expected] of cases) {
    strictEqual(values.sameValue(actual, expected), true, name);
  }
});

test("integer identities forward values or produce literals", () => {
  const values = new ValueResolver();
  const value = values.producer(Integer[32]);
  const other = values.producer(Integer[32]);
  const byte = values.producer(Integer[8]);
  const wide = values.producer(Integer[64]);
  const count = values.producer(Integer[32]);
  const zero = i32(0);
  const one = i32(1);
  const allBits = i32(-1);
  const equivalentA = value.add(other);
  const equivalentB = value.add(other);
  const cases: readonly (readonly [string, ValueRef, ValueRef])[] = [
    ["x + 0", value.add(0), value],
    ["0 + x", zero.add(value), value],
    ["x - 0", value.sub(0), value],
    ["x * 1", value.mul(1), value],
    ["1 * x", one.mul(value), value],
    ["x * 0", value.mul(0), zero],
    ["0 * x", zero.mul(value), zero],
    ["signed x / 1", value.signed.div(1), value],
    ["unsigned x / 1", value.unsigned.div(1), value],
    ["signed x % 1", value.signed.rem(1), zero],
    ["signed x % -1", value.signed.rem(-1), zero],
    ["unsigned x % 1", value.unsigned.rem(1), zero],
    ["x ^ 0", value.xor(0), value],
    ["0 ^ x", zero.xor(value), value],
    ["x | 0", value.or(0), value],
    ["0 | x", zero.or(value), value],
    ["x | all bits", value.or(-1), allBits],
    ["all bits | x", allBits.or(value), allBits],
    ["x & all bits", value.and(-1), value],
    ["all bits & x", allBits.and(value), value],
    ["x & 0", value.and(0), zero],
    ["0 & x", zero.and(value), zero],
    ["equivalent x - x", equivalentA.sub(equivalentB), zero],
    ["equivalent x ^ x", equivalentA.xor(equivalentB), zero],
    ["equivalent x | x", equivalentA.or(equivalentB), equivalentA],
    ["equivalent x & x", equivalentA.and(equivalentB), equivalentA],
    ["carrier-masked narrow left shift", byte.shl(32), byte],
    ["carrier-masked narrow signed shift", byte.signed.shr(32), byte],
    ["carrier-masked narrow unsigned shift", byte.unsigned.shr(32), byte],
    ["carrier-masked i64 shift", wide.shl(64), wide],
    ["zero left shift", zero.shl(count), zero],
    ["logical-width rotate left", byte.rotl(8), byte],
    ["logical-width rotate right", byte.rotr(8), byte]
  ];

  for (const [name, actual, expected] of cases) {
    strictEqual(values.sameValue(actual, expected), true, name);
  }
});

test("integer predicates and selections use resolved value identity", () => {
  const values = new ValueResolver();
  const left = values.producer(Integer[32]);
  const right = values.producer(Integer[32]);
  const condition = values.producer(Integer[1]);
  const equivalentA = left.add(right);
  const equivalentB = left.add(right);
  const zero = integer(1, 0);
  const one = integer(1, 1);
  const cases: readonly (readonly [string, ValueRef, ValueRef])[] = [
    ["eq", equivalentA.eq(equivalentB), one],
    ["ne", equivalentA.ne(equivalentB), zero],
    ["unsigned lt", equivalentA.unsigned.lt(equivalentB), zero],
    ["unsigned le", equivalentA.unsigned.le(equivalentB), one],
    ["unsigned gt", equivalentA.unsigned.gt(equivalentB), zero],
    ["unsigned ge", equivalentA.unsigned.ge(equivalentB), one],
    ["signed lt", equivalentA.signed.lt(equivalentB), zero],
    ["signed le", equivalentA.signed.le(equivalentB), one],
    ["signed gt", equivalentA.signed.gt(equivalentB), zero],
    ["signed ge", equivalentA.signed.ge(equivalentB), one],
    ["x == 0", left.eq(0), left.eqz()],
    ["0 == x", i32(0).eq(left), left.eqz()],
    ["x != 0", left.ne(0), nonzero(left)],
    ["0 != x", i32(0).ne(left), nonzero(left)],
    ["nonzero bit", nonzero(condition), condition]
  ];

  for (const [name, actual, expected] of cases) {
    strictEqual(values.sameValue(actual, expected), true, name);
  }
});
