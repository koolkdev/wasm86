import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createProgramResources, type MemoryImport } from "#compiler/program/resources.js";
import { resourceRef } from "#compiler/reference.js";

test("program resources retain owner-provided memory imports", () => {
  const state = memoryImport("test.state", "state");
  const guest = memoryImport("test.guest", "guest");
  const resources = createProgramResources([state, guest]);

  deepStrictEqual(resources.memoryImports, [state, guest]);
});

test("same-id resource refs remain distinct", () => {
  const first = memoryImport("state", "first");
  const second = memoryImport("state", "second");
  const resources = createProgramResources([first, second]);

  strictEqual(resources.memoryImports[0]?.ref, first.ref);
  strictEqual(resources.memoryImports[1]?.ref, second.ref);
});

test("memory imports may reuse a field name in different modules", () => {
  const first = {
    ...memoryImport("first", "shared"),
    moduleName: "first"
  };
  const second = {
    ...memoryImport("second", "shared"),
    moduleName: "second"
  };

  deepStrictEqual(createProgramResources([first, second]).memoryImports, [first, second]);
});

function memoryImport(id: string, name: string): MemoryImport {
  return {
    ref: resourceRef(id),
    moduleName: "test",
    name,
    limits: { minPages: 1 }
  };
}
