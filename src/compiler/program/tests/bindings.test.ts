import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { resourceRef } from "#compiler/ir/resource.js";
import { createModuleBindings } from "#compiler/program/bindings.js";
import { functionType } from "#compiler/program/function-type.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import {
  functionRef,
  tableRef
} from "#compiler/program/refs.js";

test("module bindings preserve each identity space", () => {
  const type = functionType([], []);
  const definition = new FunctionDefinition({
    ref: functionRef("test.bound-definition"),
    type,
    effects: { reads: [], writes: [] },
    owner: undefined,
    build: () => {}
  });
  const table = tableRef("test.bound-table");
  const resource = resourceRef("test.bound-resource");
  const bindings = createModuleBindings({
    functionDefinitions: new Map([[definition, 1]]),
    types: new Map([[type, 2]]),
    tables: new Map([[table, 3]]),
    resources: new Map([[resource, 4]])
  });

  strictEqual(bindings.functionIndex(definition), 1);
  strictEqual(bindings.typeIndex(type), 2);
  strictEqual(bindings.tableIndex(table), 3);
  strictEqual(bindings.resourceIndex(resource), 4);
});

test("module bindings reject same-id lookalikes", () => {
  const resource = resourceRef("test.identity-bound-resource");
  const bindings = createModuleBindings({
    functionDefinitions: new Map(),
    types: new Map(),
    tables: new Map(),
    resources: new Map([[resource, 0]])
  });

  throws(
    () => bindings.resourceIndex(resourceRef(resource.id)),
    /missing resolved resource test\.identity-bound-resource/
  );
});
