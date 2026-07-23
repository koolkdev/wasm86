import {
  deepStrictEqual,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { resourceRead } from "#compiler/ir/operations/resource.js";
import {
  resourceRef,
  type ResourceByteOperand,
  type ResourceEffect,
  type ResourceRef
} from "#compiler/ir/resource.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  wasmCodeFunctionCount,
  wasmDefinedFunctionCount
} from "#compiler/encoder/tests/body-opcodes.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { compileProgram } from "#compiler/compile.js";
import { functionType } from "#compiler/ir/function.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef, tableRef } from "#compiler/ir/refs.js";
import { createProgramResources } from "#compiler/program/resources.js";

const noEffects = { reads: [], writes: [] } as const;
const emptyResources = createProgramResources([]);

test("program closure retains reachable function imports in declaration order", () => {
  const program = new ProgramBuilder(emptyResources);
  const liveType = functionType(["i32"], ["i32"]);
  const unusedType = functionType([], ["i64"]);
  const callerType = functionType([], ["i32"]);
  const firstRef = functionRef("test.function-imports.first");
  const unusedRef = functionRef("test.function-imports.unused");
  const secondRef = functionRef("test.function-imports.second");
  const first = program.importFunction({
    ref: firstRef,
    type: liveType,
    effects: noEffects,
    moduleName: "test host",
    name: "first"
  });
  const unused = program.importFunction({
    ref: unusedRef,
    type: unusedType,
    effects: noEffects,
    moduleName: "test host",
    name: "unused"
  });
  const second = program.importFunction({
    ref: secondRef,
    type: liveType,
    effects: noEffects,
    moduleName: "test host",
    name: "second"
  });

  strictEqual(first.ref, firstRef);
  strictEqual(first.type, liveType);
  deepStrictEqual(first.effects, noEffects);

  const caller = program.defineFunction({
    ref: functionRef("test.function-imports.ordered-caller"),
    type: callerType,
    effects: noEffects
  }, (fn) => {
    fn.region.call(unused, []);
    const firstResult = fn.region.call(first, [fn.values.const(20)])[0];

    ok(firstResult !== undefined, "missing first imported-call result");
    const secondResult = fn.region.call(second, [firstResult])[0];

    ok(secondResult !== undefined, "missing second imported-call result");
    fn.return([secondResult]);
  });

  program.exportFunction({
    ref: functionExportRef("test.function-imports.ordered-export"),
    name: "entry",
    target: caller.ref
  });

  const closed = program.finish();

  deepStrictEqual(closed.functionImports, [first, second]);
  ok(closed.functionTypes.includes(liveType));
  strictEqual(closed.functionTypes.includes(unusedType), false);

  const compiled = compileProgram(closed);

  deepStrictEqual(compiled.functionImports, [
    { ref: firstRef, moduleName: "test host", name: "first" },
    { ref: secondRef, moduleName: "test host", name: "second" }
  ]);
  const firstCompiled = compiled.functionImports[0];

  ok(firstCompiled !== undefined, "missing first compiled function import");
  deepStrictEqual(
    Object.keys(firstCompiled).sort(),
    ["moduleName", "name", "ref"]
  );

  const moduleImports = WebAssembly.Module.imports(
    new WebAssembly.Module(compiled.bytes)
  ).filter((entry) => entry.kind === "function");

  deepStrictEqual(moduleImports, [
    { module: "test host", name: "first", kind: "function" },
    { module: "test host", name: "second", kind: "function" }
  ]);
});

test("ordinary and returned imported calls execute through mixed exact bindings", () => {
  const resource = resourceRef("test.function-imports.mixed-memory");
  const resources = createProgramResources([{
    ref: resource,
    moduleName: "external runtime/2026",
    name: "memory.with punctuation",
    limits: { minPages: 1 }
  }]);
  const program = new ProgramBuilder(resources);
  const importedType = functionType(["i32"], ["i32"]);
  const importedRef = functionRef("test.function-imports.mixed-host");
  const imported = program.importFunction({
    ref: importedRef,
    type: importedType,
    effects: noEffects,
    moduleName: "external runtime/2026",
    name: "function.with punctuation"
  });
  const access = memoryRead(resource);
  const ordinary = program.defineFunction({
    ref: functionRef("test.function-imports.ordinary"),
    type: functionType([], ["i32"]),
    effects: { reads: [access], writes: [] }
  }, (fn) => {
    const loaded = fn.region.operation(resourceRead, {
      source: memoryOperand(resource, access, fn.values.const(0))
    });
    const result = fn.region.call(imported, [loaded])[0];

    ok(result !== undefined, "missing ordinary imported-call result");
    fn.return([result]);
  });
  const returned = program.defineFunction({
    ref: functionRef("test.function-imports.returned"),
    type: importedType,
    effects: noEffects
  }, (fn) => {
    const argument = fn.parameters[0];

    ok(argument !== undefined, "missing returned imported-call argument");
    fn.returnCall(imported, [argument]);
  });
  const ordinaryExport = functionExportRef(
    "test.function-imports.ordinary-export"
  );
  const returnedExport = functionExportRef(
    "test.function-imports.returned-export"
  );

  program.exportFunction({
    ref: ordinaryExport,
    name: "ordinary",
    target: ordinary.ref
  });
  program.exportFunction({
    ref: returnedExport,
    name: "returned",
    target: returned.ref
  });

  const compiled = compileProgram(program.finish());
  const memory = new WebAssembly.Memory({ initial: 1 });
  const calls: number[] = [];
  const host = (value: number): number => {
    calls.push(value);
    return value + 1;
  };
  let extraCalls = 0;

  new DataView(memory.buffer).setUint32(0, 41, true);
  const instance = instantiateCompiledProgram(compiled, {
    memories: new Map([
      [resource, memory],
      [
        resourceRef("test.function-imports.extra-memory"),
        new WebAssembly.Memory({ initial: 1 })
      ]
    ]),
    functions: new Map([
      [importedRef, host],
      [functionRef("test.function-imports.extra-host"), () => {
        extraCalls += 1;
        return 0;
      }]
    ])
  });
  const ordinaryEntry = instance.functionExports.get(ordinaryExport);
  const returnedEntry = instance.functionExports.get(returnedExport);

  ok(typeof ordinaryEntry === "function", "missing ordinary function export");
  ok(typeof returnedEntry === "function", "missing returned function export");
  strictEqual(ordinaryEntry(), 42);
  strictEqual(returnedEntry(9), 10);
  deepStrictEqual(calls, [41, 9]);
  strictEqual(extraCalls, 0);
});

test("compiled function imports require their exact FunctionRef binding", () => {
  const program = new ProgramBuilder(emptyResources);
  const type = functionType([], ["i32"]);
  const importedRef = functionRef("test.function-imports.exact-host");
  const imported = program.importFunction({
    ref: importedRef,
    type,
    effects: noEffects,
    moduleName: "test",
    name: "exactHost"
  });
  const entry = program.defineFunction({
    ref: functionRef("test.function-imports.exact-entry"),
    type,
    effects: noEffects
  }, (fn) => fn.returnCall(imported, []));

  program.exportFunction({
    ref: functionExportRef("test.function-imports.exact-export"),
    name: "entry",
    target: entry.ref
  });
  const compiled = compileProgram(program.finish());

  throws(
    () => instantiateCompiledProgram(compiled, {
      memories: new Map(),
      functions: new Map()
    }),
    /missing function binding for program function test\.function-imports\.exact-host/
  );
  throws(
    () => instantiateCompiledProgram(compiled, {
      memories: new Map(),
      functions: new Map([[
        functionRef(importedRef.id),
        () => 42
      ]])
    }),
    /missing function binding for program function test\.function-imports\.exact-host/
  );
});

test("function imports reject duplicate refs and import-definition collisions", () => {
  const type = functionType([], []);
  const duplicateRef = functionRef("test.function-imports.duplicate-ref");
  const duplicate = new ProgramBuilder(emptyResources);

  duplicate.importFunction({
    ref: duplicateRef,
    type,
    effects: noEffects,
    moduleName: "test",
    name: "first"
  });
  throws(
    () => duplicate.importFunction({
      ref: duplicateRef,
      type,
      effects: noEffects,
      moduleName: "test",
      name: "second"
    }),
    /duplicate program function.*declaration/
  );

  const importFirstRef = functionRef(
    "test.function-imports.import-first-collision"
  );
  const importFirst = new ProgramBuilder(emptyResources);

  importFirst.importFunction({
    ref: importFirstRef,
    type,
    effects: noEffects,
    moduleName: "test",
    name: "importFirst"
  });
  throws(
    () => importFirst.defineFunction({
      ref: importFirstRef,
      type,
      effects: noEffects
    }, (fn) => fn.return([])),
    /duplicate program function.*declaration/
  );

  const definitionFirstRef = functionRef(
    "test.function-imports.definition-first-collision"
  );
  const definitionFirst = new ProgramBuilder(emptyResources);

  definitionFirst.defineFunction({
    ref: definitionFirstRef,
    type,
    effects: noEffects
  }, (fn) => fn.return([]));
  throws(
    () => definitionFirst.importFunction({
      ref: definitionFirstRef,
      type,
      effects: noEffects,
      moduleName: "test",
      name: "definitionFirst"
    }),
    /duplicate program function.*declaration/
  );

  const sameId = new ProgramBuilder(emptyResources);

  sameId.importFunction({
    ref: functionRef("test.function-imports.same-identity"),
    type,
    effects: noEffects,
    moduleName: "test",
    name: "sameIdentity"
  });
  sameId.defineFunction({
    ref: functionRef("test.function-imports.same-identity"),
    type,
    effects: noEffects
  }, (fn) => fn.return([]));
  throws(() => sameId.finish(), /duplicate program function identity/);
});

test("function import targets belong to the program that declared them", () => {
  const type = functionType([], []);
  const owner = new ProgramBuilder(emptyResources);
  const foreign = owner.importFunction({
    ref: functionRef("test.function-imports.foreign-target"),
    type,
    effects: noEffects,
    moduleName: "test",
    name: "foreignTarget"
  });
  const consumer = new ProgramBuilder(emptyResources);

  consumer.defineFunction({
    ref: functionRef("test.function-imports.foreign-consumer"),
    type,
    effects: noEffects
  }, (fn) => fn.returnCall(foreign, []));

  throws(() => consumer.finish(), /belongs to another program/);
});

test("function import names reject duplicates and cross-kind collisions", () => {
  {
    const program = new ProgramBuilder(emptyResources);
    const type = functionType(["i32"], ["i32"]);
    const first = program.importFunction({
      ref: functionRef("test.function-imports.duplicate-name-first"),
      type,
      effects: noEffects,
      moduleName: "host",
      name: "shared"
    });

    throws(() => {
      const second = program.importFunction({
        ref: functionRef("test.function-imports.duplicate-name-second"),
        type,
        effects: noEffects,
        moduleName: "host",
        name: "shared"
      });

      program.defineFunction({
        ref: functionRef("test.function-imports.duplicate-name-caller"),
        type: functionType([], ["i32"]),
        effects: noEffects
      }, (fn) => {
        const firstResult = fn.region.call(first, [fn.values.const(1)])[0];

        ok(firstResult !== undefined, "missing duplicate-name first result");
        const secondResult = fn.region.call(second, [firstResult])[0];

        ok(secondResult !== undefined, "missing duplicate-name second result");
        fn.return([secondResult]);
      });
      program.finish();
    }, /duplicate .*external identity: host\.shared/);
  }

  {
    const memory = resourceRef("test.function-imports.cross-kind-memory");
    const resources = createProgramResources([{
      ref: memory,
      moduleName: "host",
      name: "shared",
      limits: { minPages: 1 }
    }]);
    const program = new ProgramBuilder(resources);
    const access = memoryRead(memory);

    throws(() => {
      const imported = program.importFunction({
        ref: functionRef("test.function-imports.cross-kind-host"),
        type: functionType(["i32"], ["i32"]),
        effects: noEffects,
        moduleName: "host",
        name: "shared"
      });

      program.defineFunction({
        ref: functionRef("test.function-imports.cross-kind-caller"),
        type: functionType([], ["i32"]),
        effects: { reads: [access], writes: [] }
      }, (fn) => {
        const loaded = fn.region.operation(resourceRead, {
          source: memoryOperand(memory, access, fn.values.const(0))
        });
        const result = fn.region.call(imported, [loaded])[0];

        ok(result !== undefined, "missing cross-kind imported-call result");
        fn.return([result]);
      });
      program.finish();
    }, /external.*host\.shared|host\.shared.*collision/);
  }

  {
    const program = new ProgramBuilder(emptyResources);

    program.importTable({
      ref: tableRef("test.function-imports.cross-kind-table"),
      moduleName: "host",
      name: "shared",
      limits: { minElements: 1 }
    });
    program.importFunction({
      ref: functionRef("test.function-imports.cross-kind-table-host"),
      type: functionType([], []),
      effects: noEffects,
      moduleName: "host",
      name: "shared"
    });

    throws(
      () => program.finish(),
      /duplicate .*external identity: host\.shared/
    );
  }
});

test("function imports require external module and field names", () => {
  const type = functionType([], []);
  const emptyModule = new ProgramBuilder(emptyResources);

  emptyModule.importFunction({
    ref: functionRef("test.function-imports.empty-module"),
    type,
    effects: noEffects,
    moduleName: "",
    name: "host"
  });
  throws(() => emptyModule.finish(), /empty external module name/);

  const emptyField = new ProgramBuilder(emptyResources);

  emptyField.importFunction({
    ref: functionRef("test.function-imports.empty-field"),
    type,
    effects: noEffects,
    moduleName: "host",
    name: ""
  });
  throws(() => emptyField.finish(), /empty external field name/);
});

test("function import effects participate in caller effect validation", () => {
  const resource = resourceRef("test.function-imports.effect-resource");
  const resources = createProgramResources([{
    ref: resource,
    moduleName: "test",
    name: "effectResource",
    limits: { minPages: 1 }
  }]);
  const effect = memoryRead(resource);
  const program = new ProgramBuilder(resources);
  const imported = program.importFunction({
    ref: functionRef("test.function-imports.effectful-host"),
    type: functionType([], []),
    effects: { reads: [], writes: [effect] },
    moduleName: "test",
    name: "effectfulHost"
  });

  program.defineFunction({
    ref: functionRef("test.function-imports.effect-caller"),
    type: functionType([], []),
    effects: noEffects
  }, (fn) => {
    fn.region.call(imported, []);
    fn.return([]);
  });

  throws(() => program.finish(), /effect-caller.*undeclared write effect/);
});

test("imported indexes prefix local calls, exports, and branch hints", () => {
  const program = new ProgramBuilder(emptyResources);
  const type = functionType([], ["i32"]);
  const importedRef = functionRef("test.function-imports.indexed-host");
  const imported = program.importFunction({
    ref: importedRef,
    type,
    effects: noEffects,
    moduleName: "test",
    name: "indexedHost"
  });
  const helper = program.defineFunction({
    ref: functionRef("test.function-imports.indexed-helper"),
    type,
    effects: noEffects
  }, (fn) => {
    const result = fn.region.call(imported, [])[0];

    ok(result !== undefined, "missing indexed imported-call result");
    fn.return([fn.values.binary("add", result, fn.values.const(10))]);
  });
  const entry = program.defineFunction({
    ref: functionRef("test.function-imports.indexed-entry"),
    type,
    effects: noEffects
  }, (fn) => {
    const result = fn.region.call(helper, [])[0];

    ok(result !== undefined, "missing indexed local-call result");
    fn.region.if(result, () => {}, { hint: "unlikely" });
    fn.return([fn.values.binary("add", result, fn.values.const(1))]);
  });
  const exportRef = functionExportRef("test.function-imports.hinted-export");

  program.exportFunction({ ref: exportRef, name: "entry", target: entry.ref });
  const compiled = compileProgram(program.finish());

  strictEqual(wasmDefinedFunctionCount(compiled.bytes), 2);
  strictEqual(wasmCodeFunctionCount(compiled.bytes), 2);

  const module = new WebAssembly.Module(compiled.bytes);

  deepStrictEqual(WebAssembly.Module.imports(module), [{
    module: "test",
    name: "indexedHost",
    kind: "function"
  }]);
  deepStrictEqual(WebAssembly.Module.exports(module), [{
    name: "entry",
    kind: "function"
  }]);

  const hintSections = WebAssembly.Module.customSections(
    module,
    "metadata.code.branch_hint"
  );
  const hintSection = hintSections[0];

  strictEqual(hintSections.length, 1);
  ok(hintSection !== undefined, "missing branch-hint section");
  const hintBytes = new Uint8Array(hintSection);

  strictEqual(hintBytes[0], 1, "expected one hinted function");
  strictEqual(hintBytes[1], 2, "local function index must include one import");

  const instance = instantiateCompiledProgram(compiled, {
    memories: new Map(),
    functions: new Map([[importedRef, () => 7]])
  });
  const run = instance.functionExports.get(exportRef);

  ok(typeof run === "function", "missing hinted local export");
  strictEqual(run(), 18);
});

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
