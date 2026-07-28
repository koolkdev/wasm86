import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  resourceRef,
  type ResourceByteOperand,
  type ResourceEffect,
  type ResourceRef
} from "#compiler/ir/resource.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { resourceRead } from "#compiler/ir/operations/resource.js";
import { compileProgram } from "#compiler/compile.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/ir/function.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef, tableRef } from "#compiler/ir/refs.js";
import { createProgramResources, type ProgramResources } from "#compiler/program/resources.js";

const fixture = createTestResources();
const readType = functionType([], ["i32"]);

test("compiled programs preserve reachable memories, exact exports, and runnable bytes", async () => {
  const program = new ProgramBuilder(fixture.resources);
  const access = memoryRead(fixture.used);
  const read = program.defineFunction(
    {
      ref: functionRef("test.compile.read"),
      type: readType,
      effects: { reads: [access], writes: [] }
    },
    (fn) => {
      const value = fn.region.operation(resourceRead, {
        source: memoryOperand(fixture.used, access, fn.values.const(0))
      });

      fn.return([value]);
    }
  );
  const exportRef = functionExportRef("test.compile.read-export");

  program.exportFunction({ ref: exportRef, name: "read", target: read.ref });
  const compiled = compileProgram(program.finish());

  strictEqual(compiled.memoryImports.length, 1);
  strictEqual(compiled.memoryImports[0]?.ref, fixture.used);
  deepStrictEqual(compiled.memoryImports[0], {
    ref: fixture.used,
    moduleName: "testProgram",
    name: "used",
    limits: { minPages: 1 }
  });
  strictEqual(compiled.functionExports.length, 1);
  strictEqual(compiled.functionExports[0]?.ref, exportRef);
  strictEqual(compiled.functionExports[0]?.name, "read");
  deepStrictEqual(compiled.functionImports, []);

  const memory = new WebAssembly.Memory({ initial: 1 });

  new DataView(memory.buffer).setUint32(0, 42, true);
  const module = await WebAssembly.compile(compiled.bytes);
  const instance = await WebAssembly.instantiate(module, {
    testProgram: { used: memory }
  });
  const exportedRead = instance.exports.read;

  strictEqual(typeof exportedRead, "function");
  strictEqual((exportedRead as () => number)(), 42);
});

test("compiled control preserves a selected trap when its value is unused", () => {
  const program = new ProgramBuilder(createProgramResources([]));
  const entry = program.defineFunction(
    {
      ref: functionRef("test.compile.selected-trap"),
      type: functionType(["i32"], []),
      effects: { reads: [], writes: [] }
    },
    (fn) => {
      fn.region.ifValue(
        fn.parameters[0]!,
        (then) => then.values.const(7),
        (otherwise) => otherwise.values.unreachable()
      );
      fn.return([]);
    }
  );
  const exportRef = functionExportRef("test.compile.selected-trap-export");

  program.exportFunction({
    ref: exportRef,
    name: "run",
    target: entry.ref
  });
  const compiled = compileProgram(program.finish());
  const instance = new WebAssembly.Instance(new WebAssembly.Module(compiled.bytes));
  const run = instance.exports.run;

  strictEqual(typeof run, "function");
  if (typeof run !== "function") {
    throw new Error("compiled control export is missing");
  }
  strictEqual(run(1), undefined);
  throws(() => run(0), WebAssembly.RuntimeError);
});

test("compiled indirect calls use their selected table", () => {
  const program = new ProgramBuilder(createProgramResources([]));
  const type = functionType(["i32"], ["i32"]);
  const unusedTable = tableRef("test.compile.indirect-unused-table");
  const selectedTable = tableRef("test.compile.indirect-selected-table");

  program.importTable({
    ref: unusedTable,
    moduleName: "test",
    name: "unusedTable",
    limits: { minElements: 1 }
  });
  program.importTable({
    ref: selectedTable,
    moduleName: "test",
    name: "selectedTable",
    limits: { minElements: 1 }
  });
  const target = program.defineFunction(
    {
      ref: functionRef("test.compile.indirect-target"),
      type,
      effects: { reads: [], writes: [] }
    },
    (fn) => {
      const argument = fn.parameters[0];

      ok(argument !== undefined, "missing indirect target argument");
      fn.return([argument]);
    }
  );
  const ordinary = program.defineFunction(
    {
      ref: functionRef("test.compile.indirect-ordinary"),
      type,
      effects: { reads: [], writes: [] }
    },
    (fn) => {
      const argument = fn.parameters[0];

      ok(argument !== undefined, "missing ordinary indirect-call argument");
      fn.return(
        fn.region.call(
          fn.region.indirectTarget({
            table: selectedTable,
            type,
            effects: { reads: [], writes: [] },
            elementIndex: fn.values.const(0)
          }),
          [argument]
        )
      );
    }
  );
  const returned = program.defineFunction(
    {
      ref: functionRef("test.compile.indirect-returned"),
      type,
      effects: { reads: [], writes: [] }
    },
    (fn) => {
      const argument = fn.parameters[0];

      ok(argument !== undefined, "missing returned indirect-call argument");
      fn.returnCall(
        fn.region.indirectTarget({
          table: selectedTable,
          type,
          effects: { reads: [], writes: [] },
          elementIndex: fn.values.const(0)
        }),
        [argument]
      );
    }
  );

  for (const [name, targetRef] of [
    ["target", target.ref],
    ["ordinary", ordinary.ref],
    ["returned", returned.ref]
  ] as const) {
    program.exportFunction({
      ref: functionExportRef(`test.compile.indirect-${name}-export`),
      name,
      target: targetRef
    });
  }

  const unused = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const selected = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(compileProgram(program.finish()).bytes),
    { test: { unusedTable: unused, selectedTable: selected } }
  );
  const exportedTarget = instance.exports.target;

  ok(typeof exportedTarget === "function", "missing indirect target export");
  selected.set(0, exportedTarget);

  const ordinaryEntry = instance.exports.ordinary;
  const returnedEntry = instance.exports.returned;

  ok(typeof ordinaryEntry === "function", "missing ordinary indirect caller");
  ok(typeof returnedEntry === "function", "missing returned indirect caller");
  strictEqual(ordinaryEntry(37), 37);
  strictEqual(returnedEntry(73), 73);
});

test("compiled returned calls keep deep recursion on a bounded stack", () => {
  const program = new ProgramBuilder(createProgramResources([]));
  const type = functionType(["i32"], []);
  const countdown = program.defineFunction(
    {
      ref: functionRef("test.compile.tail-countdown"),
      type,
      effects: { reads: [], writes: [] }
    },
    (fn, self) => {
      const remaining = fn.parameters[0];

      ok(remaining !== undefined, "missing countdown argument");
      fn.region.if(
        remaining,
        (thenBody) => {
          thenBody.returnCall(self, [fn.values.binary("sub", remaining, fn.values.const(1))]);
        },
        {
          elseBuild: (elseBody) => {
            elseBody.return([]);
          }
        }
      );
    }
  );

  program.exportFunction({
    ref: functionExportRef("test.compile.tail-countdown-export"),
    name: "countdown",
    target: countdown.ref
  });
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(compileProgram(program.finish()).bytes)
  );
  const entry = instance.exports.countdown;

  ok(typeof entry === "function", "missing countdown export");
  strictEqual(entry(100_000), undefined);
});

type TestResources = Readonly<{
  resources: ProgramResources;
  used: ResourceRef;
}>;

function createTestResources(): TestResources {
  const used = resourceRef("test.compile.used");
  const unused = resourceRef("test.compile.unused");

  return {
    resources: createProgramResources([
      {
        ref: used,
        moduleName: "testProgram",
        name: "used",
        limits: { minPages: 1 }
      },
      {
        ref: unused,
        moduleName: "testProgram",
        name: "unused",
        limits: { minPages: 1 }
      }
    ]),
    used
  };
}

function memoryRead(resource: ResourceRef): ResourceEffect {
  return {
    space: "resource",
    resource,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: 0, byteLength: 4 }
    }
  };
}

function memoryOperand(
  resource: ResourceRef,
  effect: ResourceEffect,
  base: ValueId
): ResourceByteOperand {
  return {
    effect: { ...effect, resource },
    address: { base, displacement: 0 },
    width: 32
  };
}
