import { strictEqual } from "node:assert";
import { test } from "node:test";

import { i32, unreachable } from "#compiler/function/values.js";
import { ValueScope } from "../scope.js";
import { Integer } from "../type.js";

test("one deferred expression can be resolved by independent value scopes", () => {
  const expression = i32(4).add(3);
  const first = new ValueScope();
  const second = new ValueScope();

  strictEqual(first.constValue(expression), 7);
  strictEqual(second.constValue(expression), 7);
});

test("one expression object keeps one identity across ordinary scopes", () => {
  const root = new ValueScope();
  const first = root.childScope();
  const second = root.childScope();
  const expression = unreachable().add(0);

  first.resolve(expression);
  strictEqual(second.sameValue(expression, unreachable()), true);
  strictEqual(root.sameValue(expression, unreachable()), true);
});

test("resolving a narrow expression twice mints one identity", () => {
  const values = new ValueScope();
  const parameter = values.parameter(0, Integer[32]);
  const byte = parameter.truncate(8).add(1);

  values.resolve(byte);

  const identities = values.identityCount();

  values.resolve(byte);
  strictEqual(values.identityCount(), identities);
  strictEqual(byte.width, 8);
});

test("sameValue compares identities resolved in its scope", () => {
  const values = new ValueScope();
  const expression = i32(4).add(3);

  strictEqual(values.sameValue(expression, expression), true);
  strictEqual(values.sameValue(expression, i32(7)), true);
  strictEqual(values.sameValue(expression, i32(8)), false);
});
