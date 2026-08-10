import { doesNotThrow, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { i32 } from "#compiler/function/values.js";
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
});
