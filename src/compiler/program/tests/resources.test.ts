import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { resourceRef } from "#compiler/ir/resource.js";
import {
  createProgramResources,
  type MemoryImport
} from "#compiler/program/resources.js";

test("program resources retain owner-provided memory imports", () => {
  const state = memoryImport("test.state", "state");
  const guest = memoryImport("test.guest", "guest");
  const resources = createProgramResources([state, guest]);

  deepStrictEqual(resources.memoryImports, [state, guest]);
});

test("program resources reject duplicate refs and external names", () => {
  const state = memoryImport("test.state", "state");

  throws(
    () => createProgramResources([
      state,
      { ...state, name: "other" }
    ]),
    /duplicate program resource declaration: test.state/
  );
  throws(
    () => createProgramResources([
      memoryImport("test.state", "state"),
      memoryImport("test.other", "state")
    ]),
    /duplicate memory external identity: test.state/
  );
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

  deepStrictEqual(
    createProgramResources([first, second]).memoryImports,
    [first, second]
  );
});

test("program resources validate memory names and limits", () => {
  throws(
    () => createProgramResources([{
      ...memoryImport("test.state", "state"),
      moduleName: ""
    }]),
    /empty external module name/
  );
  throws(
    () => createProgramResources([{
      ...memoryImport("test.state", "state"),
      name: ""
    }]),
    /empty external field name/
  );
  throws(
    () => createProgramResources([{
      ...memoryImport("test.state", "state"),
      limits: { minPages: -1 }
    }]),
    /memory minimum pages out of range/
  );
  throws(
    () => createProgramResources([{
      ...memoryImport("test.state", "state"),
      limits: { minPages: 2, maxPages: 1 }
    }]),
    /maximum pages are below its minimum/
  );
  throws(
    () => createProgramResources([{
      ...memoryImport("test.state", "state"),
      limits: { minPages: 0x1_0001 }
    }]),
    /memory minimum pages out of range/
  );
});

function memoryImport(id: string, name: string): MemoryImport {
  return {
    ref: resourceRef(id),
    moduleName: "test",
    name,
    limits: { minPages: 1 }
  };
}
