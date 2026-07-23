import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { resourceRef } from "#compiler/ir/resource.js";
import { tableRef } from "#compiler/ir/refs.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import {
  createProgramResources,
  type MemoryImport
} from "#compiler/program/resources.js";

test("program resources retain owner-provided memory imports", () => {
  const state = memoryImport("test.state", "state");
  const guest = memoryImport("test.guest", "guest");
  const resources = createProgramResources([state, guest]);

  deepStrictEqual(resources.memoryImports, [state, guest]);
  strictEqual(resources.memoryImports[0], state);
  strictEqual(resources.memoryImports[1], guest);
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

test("external memory identity compares module and field names separately", () => {
  const first = {
    ...memoryImport("first", "field"),
    moduleName: "test\u0000nested"
  };
  const second = {
    ...memoryImport("second", "nested\u0000field"),
    moduleName: "test"
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

test("program declarations validate table limits", () => {
  const negativeMinimum = new ProgramBuilder(createProgramResources([]));

  negativeMinimum.importTable({
    ref: tableRef("test.negative-minimum"),
    moduleName: "test",
    name: "negativeMinimum",
    limits: { minElements: -1 }
  });
  throws(
    () => negativeMinimum.finish(),
    /minimum elements out of range/
  );

  const invertedRange = new ProgramBuilder(createProgramResources([]));

  invertedRange.importTable({
    ref: tableRef("test.inverted-range"),
    moduleName: "test",
    name: "invertedRange",
    limits: { minElements: 2, maxElements: 1 }
  });
  throws(
    () => invertedRange.finish(),
    /maximum elements are below its minimum/
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
