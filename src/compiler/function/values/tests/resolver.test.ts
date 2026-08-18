import { doesNotThrow, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { f32, i32, integer, select, type ValueRef } from "#compiler/function/values.js";
import { ValueResolver } from "../resolver.js";
import { Float, Integer } from "../type.js";

test("parameters are positional and producers are occurrences", () => {
  const values = new ValueResolver();
  const [first, second, single] = values.parameters([Integer[8], Integer[8], Float[32]] as const);
  const repeated = values.parameter(0, Integer[8]);
  const firstProducer = values.producer(Integer[8]);
  const secondProducer = values.producer(Integer[8]);

  strictEqual(first.kind, "integer");
  strictEqual(first.width, 8);
  strictEqual(single.kind, "float");
  strictEqual(single.width, 32);
  strictEqual(values.sameValue(first, repeated), true);
  strictEqual(values.sameValue(first, second), false);
  strictEqual(values.sameValue(firstProducer, secondProducer), false);
});

test("equivalent expressions resolve to one function value", () => {
  const values = new ValueResolver();
  const integer = values.producer(Integer[32]);
  const otherInteger = values.producer(Integer[32]);
  const float = values.producer(Float[32]);

  strictEqual(values.sameValue(integer.add(1).xor(7), integer.add(1).xor(7)), true);
  strictEqual(values.sameValue(integer.add(1).xor(7), integer.add(1).xor(6)), false);
  strictEqual(values.sameValue(integer.add(1), otherInteger.add(1)), false);
  strictEqual(values.sameValue(float.add(1), float.add(1)), true);
  strictEqual(values.sameValue(float.add(1), float.sub(1)), false);
  strictEqual(values.sameValue(f32(0), f32(-0)), false);
});

test("constant inspection observes resolved narrow integer expressions", () => {
  const values = new ValueResolver();
  const parameter = values.parameter(0, Integer[32]);

  strictEqual(values.constValue(i32(4).add(3)), 7);
  strictEqual(values.constValue(i32(-1)), -1);
  strictEqual(values.constValue(parameter), undefined);
});

test("select forwards resolved arms", () => {
  const values = new ValueResolver();
  const condition = values.producer(Integer[1]);
  const firstInteger = values.producer(Integer[32]);
  const secondInteger = values.producer(Integer[32]);
  const firstFloat = values.producer(Float[32]);
  const secondFloat = values.producer(Float[32]);
  const equivalentIntegerA = firstInteger.add(1);
  const equivalentIntegerB = firstInteger.add(1);
  const equivalentFloatA = firstFloat.add(1);
  const equivalentFloatB = firstFloat.add(1);
  const cases: readonly (readonly [string, ValueRef, ValueRef])[] = [
    [
      "integer same arms",
      select(condition, equivalentIntegerA, equivalentIntegerB),
      equivalentIntegerA
    ],
    ["float same arms", select(condition, equivalentFloatA, equivalentFloatB), equivalentFloatA],
    ["false condition", select(integer(1, 0), firstInteger, secondInteger), secondInteger],
    ["true condition", select(integer(1, 1), firstFloat, secondFloat), firstFloat]
  ];

  for (const [name, actual, expected] of cases) {
    strictEqual(values.sameValue(actual, expected), true, name);
  }
});

test("function sources cannot cross resolvers", () => {
  const first = new ValueResolver();
  const second = new ValueResolver();
  const pure = i32(4).add(3);
  const owned = first.producer(Integer[32]);

  doesNotThrow(() => first.resolve(pure));
  doesNotThrow(() => second.resolve(pure));
  throws(() => second.resolve(owned), /value source belongs to another resolver/);
  throws(() => second.resolve(owned.add(1)), /value source belongs to another resolver/);
  throws(() => second.resolve(owned.mul(0)), /value source belongs to another resolver/);
});
