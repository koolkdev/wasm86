import { doesNotThrow, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { constantValue } from "../leaves.js";
import { ValueTable } from "../table.js";

test("ancestor values retain their identity in descendant scopes", () => {
  const root = new ValueTable();
  const child = root.childScope();
  const parameterId = root.parameter(0, "i32");
  const value = root.integer(32, parameterId);
  const [childId] = child.use([value]);

  strictEqual(root.use(value), parameterId);
  strictEqual(childId, parameterId);
});

test("an expression over an ancestor value is reusable in sibling scopes", () => {
  const root = new ValueTable();
  const parameter = root.integer(32, root.parameter(0, "i32"));
  const expression = parameter.add(4).xor(7);
  const thenValues = root.childScope();
  const elseValues = root.childScope();
  const resolved = thenValues.use(expression);

  strictEqual(elseValues.use(expression), resolved);
  strictEqual(root.use(expression), resolved);
});

test("a derived value retains branch-local requirements after its first use", () => {
  const root = new ValueTable();
  const child = root.childScope();
  const sibling = root.childScope();
  const childValue = child.integer(32, child.create(constantValue, { width: 32, value: 3 }));
  const derived = childValue.add(4).xor(7);

  strictEqual(child.constValue(child.use(derived)), 0);
  throws(() => sibling.use(derived), /value is not visible in the target value scope/);
  throws(() => root.use(derived), /value is not visible in the target value scope/);
});

test("a retained expression resolves to its graph identity in children and forks", () => {
  const root = new ValueTable();
  const parameter = root.integer(32, root.parameter(0, "i32"));
  const expression = parameter.add(4).xor(7);
  const resolved = root.use(expression);
  const thenValues = root.childScope();
  const elseValues = root.childScope();
  const fork = root.fork();
  const [thenId] = thenValues.use([expression]);

  strictEqual(thenId, resolved);
  strictEqual(elseValues.use(expression), resolved);
  strictEqual(fork.use(expression), resolved);
});

test("value scopes accept ancestors and reject sibling and unrelated scopes", () => {
  const root = new ValueTable();
  const child = root.childScope();
  const sibling = root.childScope();
  const unrelated = new ValueTable();
  const outer = root.integer(32, root.create(constantValue, { width: 32, value: 4 }));
  const childOnly = child.integer(32, child.create(constantValue, { width: 32, value: 3 }));
  const siblingOnly = sibling.integer(32, sibling.create(constantValue, { width: 32, value: 2 }));
  const unrelatedValue = unrelated.integer(
    32,
    unrelated.create(constantValue, { width: 32, value: 1 })
  );

  strictEqual(child.constValue(child.use(outer.add(childOnly))), 7);
  strictEqual(child.constValue(child.use(outer.eq(4))), 1);
  throws(() => root.use(childOnly), /value is not visible in the target value scope/);
  throws(
    () => child.use(siblingOnly.add(childOnly)),
    /value is not visible in the target value scope/
  );
  throws(() => child.use(unrelatedValue), /value is not visible in the target value scope/);
});

test("forks see only values retained by their source snapshot", () => {
  const source = new ValueTable();
  const retained = source.integer(32, source.create(constantValue, { width: 32, value: 7 }));
  const fork = source.fork();
  const forkOnly = fork.integer(32, fork.addNodeOutput(32));
  const sourceAfterFork = source.integer(32, source.addNodeOutput(32));

  strictEqual(fork.constValue(fork.use(retained)), 7);
  throws(() => fork.use(sourceAfterFork), /value is not visible in the target value scope/);
  throws(() => source.use(forkOnly), /value is not visible in the target value scope/);
});

test("forks retain resolved prefixes but isolate later expression resolution", () => {
  const source = new ValueTable();
  const parameter = source.integer(32, source.parameter(0, "i32"));
  const retainedExpression = parameter.add(4).xor(7);
  const retained = source.use(retainedExpression);
  const fork = source.fork();

  strictEqual(fork.use(retainedExpression), retained);

  const isolatedExpression = parameter.add(9).xor(3);
  const forkOnly = fork.use(isolatedExpression);
  const sourceOnly = source.use(isolatedExpression);
  const forkOnlyValue = fork.integer(32, forkOnly);
  const sourceOnlyValue = source.integer(32, sourceOnly);

  throws(() => source.use(forkOnlyValue), /value is not visible in the target value scope/);
  throws(() => fork.use(sourceOnlyValue), /value is not visible in the target value scope/);
});

test("nested forks retain each source snapshot", () => {
  const root = new ValueTable();
  const rootValue = root.integer(32, root.create(constantValue, { width: 32, value: 7 }));
  const first = root.fork();
  const firstValue = first.integer(32, first.addNodeOutput(32));
  const nested = first.fork();
  const nestedOnly = nested.integer(32, nested.addNodeOutput(32));
  const firstAfterNested = first.integer(32, first.addNodeOutput(32));

  strictEqual(nested.constValue(nested.use(rootValue)), 7);
  doesNotThrow(() => nested.use(firstValue));
  throws(() => nested.use(firstAfterNested), /value is not visible in the target value scope/);
  throws(() => first.use(nestedOnly), /value is not visible in the target value scope/);
});

test("forks inherit the ancestry of a child scope", () => {
  const root = new ValueTable();
  const child = root.childScope();
  const sibling = root.childScope();
  const rootValue = root.integer(32, root.create(constantValue, { width: 32, value: 1 }));
  const childValue = child.integer(32, child.create(constantValue, { width: 32, value: 2 }));
  const siblingValue = sibling.integer(32, sibling.create(constantValue, { width: 32, value: 3 }));
  const scratch = child.fork();

  doesNotThrow(() => scratch.use(rootValue));
  doesNotThrow(() => scratch.use(childValue));
  throws(() => scratch.use(siblingValue), /value is not visible in the target value scope/);
});

test("sameValue recognizes one graph value across scopes and forks", () => {
  const root = new ValueTable();
  const firstId = root.parameter(0, "i32");
  const secondId = root.parameter(1, "i32");
  const first = root.integer(32, firstId);
  const second = root.integer(32, secondId);
  const child = root.childScope();
  const childCopy = child.integer(32, firstId);
  const fork = root.fork();
  const forkCopy = fork.integer(32, firstId);

  strictEqual(child.sameValue(first, childCopy), true);
  strictEqual(fork.sameValue(first, forkCopy), true);
  strictEqual(root.sameValue(first, second), false);
});
