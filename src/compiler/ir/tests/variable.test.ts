import { notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { VariableRef } from "#compiler/ir/variable.js";

test("every variable has a fresh opaque identity", () => {
  const first = new VariableRef("i32");
  const second = new VariableRef("i32");

  notStrictEqual(first, second);
  notStrictEqual(first, new VariableRef("i64"));
});

test("a variable exposes its value type", () => {
  const variable = new VariableRef("i64");

  strictEqual(variable.kind, "variable");
  strictEqual(variable.type, "i64");
});
