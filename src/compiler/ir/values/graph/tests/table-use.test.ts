import { strictEqual } from "node:assert";
import { test } from "node:test";

import { i32, unreachable } from "#compiler/ir/values.js";
import { ValueTable } from "../table.js";

test("one deferred expression can be resolved by independent graphs", () => {
  const expression = i32(4).add(3);
  const first = new ValueTable();
  const second = new ValueTable();

  strictEqual(first.constValue(first.use(expression)), 7);
  strictEqual(second.constValue(second.use(expression)), 7);
});

test("one expression object keeps one logical identity across ordinary scopes", () => {
  const root = new ValueTable();
  const first = root.childScope();
  const second = root.childScope();
  const expression = unreachable().add(1);
  const resolved = first.use(expression);

  strictEqual(second.use(expression), resolved);
  strictEqual(root.use(expression), resolved);
});

test("use resolves a narrow expression directly to its logical value", () => {
  const values = new ValueTable();
  const parameter = values.integer(32, values.parameter(0, 32));
  const byte = parameter.truncate(8).add(1);
  const resolved = values.use(byte);
  const size = values.size();

  strictEqual(values.use(byte), resolved);
  strictEqual(values.size(), size);
  strictEqual(values.bitWidth(resolved), 8);
});

test("sameValue compares logical identities resolved in its graph", () => {
  const values = new ValueTable();
  const expression = i32(4).add(3);

  strictEqual(values.sameValue(expression, expression), true);
  strictEqual(values.sameValue(expression, i32(7)), true);
  strictEqual(values.sameValue(expression, i32(8)), false);
});
