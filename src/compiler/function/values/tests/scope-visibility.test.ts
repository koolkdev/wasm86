import { doesNotThrow, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ValueScope } from "../scope.js";
import { Integer } from "../type.js";

test("ancestor values retain their identity in descendant scopes", () => {
  const root = new ValueScope();
  const child = root.childScope();
  const parameter = root.parameter(0, Integer[32]);

  strictEqual(child.sameValue(parameter, root.parameter(0, Integer[32])), true);
  strictEqual(root.sameValue(parameter, root.parameter(0, Integer[32])), true);
});

test("an expression over an ancestor value is reusable in sibling scopes", () => {
  const root = new ValueScope();
  const parameter = root.parameter(0, Integer[32]);
  const expression = parameter.add(4).xor(7);
  const thenValues = root.childScope();
  const elseValues = root.childScope();

  strictEqual(thenValues.sameValue(expression, parameter.add(4).xor(7)), true);
  doesNotThrow(() => elseValues.resolve(expression));
  doesNotThrow(() => root.resolve(expression));
});

test("a derived value retains branch-local requirements after its first use", () => {
  const root = new ValueScope();
  const child = root.childScope();
  const sibling = root.childScope();
  const childValue = child.producer(Integer[32]);
  const derived = childValue.add(4).xor(7);

  strictEqual(child.constValue(derived), undefined);
  throws(() => sibling.resolve(derived), /value is not visible in the target value scope/);
  throws(() => root.resolve(derived), /value is not visible in the target value scope/);
});

test("a retained expression resolves to its identity in children and forks", () => {
  const root = new ValueScope();
  const parameter = root.parameter(0, Integer[32]);
  const expression = parameter.add(4).xor(7);

  root.resolve(expression);

  const thenValues = root.childScope();
  const elseValues = root.childScope();
  const fork = root.fork();

  strictEqual(thenValues.sameValue(expression, parameter.add(4).xor(7)), true);
  strictEqual(elseValues.sameValue(expression, parameter.add(4).xor(7)), true);
  strictEqual(fork.sameValue(expression, parameter.add(4).xor(7)), true);
});

test("value scopes accept ancestors and reject sibling and unrelated scopes", () => {
  const root = new ValueScope();
  const child = root.childScope();
  const sibling = root.childScope();
  const unrelated = new ValueScope();
  const outer = root.producer(Integer[32]);
  const childOnly = child.producer(Integer[32]);
  const siblingOnly = sibling.producer(Integer[32]);
  const unrelatedValue = unrelated.producer(Integer[32]);

  doesNotThrow(() => child.resolve(outer.add(childOnly)));
  strictEqual(child.constValue(outer.eq(outer)), 1);
  throws(() => root.resolve(childOnly), /value is not visible in the target value scope/);
  throws(
    () => child.resolve(siblingOnly.add(childOnly)),
    /value is not visible in the target value scope/
  );
  throws(() => child.resolve(unrelatedValue), /value is not visible in the target value scope/);
});

test("forks see only values retained by their source snapshot", () => {
  const source = new ValueScope();
  const retained = source.producer(Integer[32]);
  const fork = source.fork();
  const forkOnly = fork.producer(Integer[32]);
  const sourceAfterFork = source.producer(Integer[32]);

  doesNotThrow(() => fork.resolve(retained));
  throws(() => fork.resolve(sourceAfterFork), /value is not visible in the target value scope/);
  throws(() => source.resolve(forkOnly), /value is not visible in the target value scope/);
});

test("forks retain resolved prefixes but isolate later expression resolution", () => {
  const source = new ValueScope();
  const parameter = source.parameter(0, Integer[32]);
  const retained = parameter.add(4).xor(7);

  source.resolve(retained);

  const fork = source.fork();
  const beforeFork = fork.identityCount();

  fork.resolve(parameter.add(4).xor(7));
  strictEqual(fork.identityCount(), beforeFork);

  const forkOnly = parameter.add(9).xor(3);

  fork.resolve(forkOnly);

  const beforeSource = source.identityCount();

  source.resolve(parameter.add(9).xor(3));
  ok(source.identityCount() > beforeSource, "the source reused an identity the fork interned");

  const sourceOnlyValue = source.producer(Integer[32]);

  throws(() => fork.resolve(sourceOnlyValue), /value is not visible in the target value scope/);
});

test("nested forks retain each source snapshot", () => {
  const root = new ValueScope();
  const rootValue = root.producer(Integer[32]);
  const first = root.fork();
  const firstValue = first.producer(Integer[32]);
  const nested = first.fork();
  const nestedOnly = nested.producer(Integer[32]);
  const firstAfterNested = first.producer(Integer[32]);

  doesNotThrow(() => nested.resolve(rootValue));
  doesNotThrow(() => nested.resolve(firstValue));
  throws(() => nested.resolve(firstAfterNested), /value is not visible in the target value scope/);
  throws(() => first.resolve(nestedOnly), /value is not visible in the target value scope/);
});

test("forks inherit the ancestry of a child scope", () => {
  const root = new ValueScope();
  const child = root.childScope();
  const sibling = root.childScope();
  const rootValue = root.producer(Integer[32]);
  const childValue = child.producer(Integer[32]);
  const siblingValue = sibling.producer(Integer[32]);
  const scratch = child.fork();

  doesNotThrow(() => scratch.resolve(rootValue));
  doesNotThrow(() => scratch.resolve(childValue));
  throws(() => scratch.resolve(siblingValue), /value is not visible in the target value scope/);
});

test("sameValue recognizes one value across scopes and forks", () => {
  const root = new ValueScope();
  const first = root.parameter(0, Integer[32]);
  const second = root.parameter(1, Integer[32]);
  const child = root.childScope();
  const childCopy = root.parameter(0, Integer[32]);
  const fork = root.fork();
  const forkCopy = root.parameter(0, Integer[32]);

  strictEqual(child.sameValue(first, childCopy), true);
  strictEqual(fork.sameValue(first, forkCopy), true);
  strictEqual(root.sameValue(first, second), false);
});
