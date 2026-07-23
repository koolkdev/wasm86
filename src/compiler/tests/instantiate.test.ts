import {
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import {
  resourceRef,
  type ResourceByteOperand,
  type ResourceEffect,
  type ResourceRef
} from "#compiler/ir/resource.js";
import { resourceRead } from "#compiler/ir/operations/resource.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  compileProgram,
  type CompiledProgram
} from "#compiler/compile.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/ir/function.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import {
  functionExportRef,
  type FunctionExportRef
} from "#compiler/program/exports.js";
import {
  functionRef,
  type FunctionRef
} from "#compiler/ir/refs.js";
import { createProgramResources } from "#compiler/program/resources.js";

const fixture = createInstanceFixture();

test("compiled program instances bind memory and functions in one external module", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });

  new DataView(memory.buffer).setUint32(0, 41, true);
  const instance = instantiateCompiledProgram(
    fixture.compiled,
    {
      memories: new Map([[fixture.resource, memory]]),
      functions: new Map([[fixture.functionRef, (value: number) => value + 1]])
    }
  );
  const run = instance.functionExports.get(fixture.exportRef);

  strictEqual(typeof run, "function");
  strictEqual((run as () => number)(), 42);
});

test("compiled program instances reject a missing memory binding", () => {
  throws(
    () => instantiateCompiledProgram(fixture.compiled, {
      memories: new Map(),
      functions: new Map([[fixture.functionRef, () => 42]])
    }),
    /missing memory binding for program resource test\.instance\.memory/
  );
});

test("compiled program instances reject a same-ID foreign resource ref", () => {
  const foreignResource = resourceRef(fixture.resource.id);
  const memory = new WebAssembly.Memory({ initial: 1 });

  throws(
    () => instantiateCompiledProgram(
      fixture.compiled,
      {
        memories: new Map([[foreignResource, memory]]),
        functions: new Map([[fixture.functionRef, () => 42]])
      }
    ),
    /missing memory binding for program resource test\.instance\.memory/
  );
});

test("compiled program instances reject a missing function binding", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });

  throws(
    () => instantiateCompiledProgram(fixture.compiled, {
      memories: new Map([[fixture.resource, memory]]),
      functions: new Map()
    }),
    /missing function binding for program function test\.instance\.function/
  );
});

test("compiled program instances reject a same-ID foreign function ref", () => {
  const foreignFunction = functionRef(fixture.functionRef.id);
  const memory = new WebAssembly.Memory({ initial: 1 });

  throws(
    () => instantiateCompiledProgram(fixture.compiled, {
      memories: new Map([[fixture.resource, memory]]),
      functions: new Map([[foreignFunction, () => 42]])
    }),
    /missing function binding for program function test\.instance\.function/
  );
});

test("compiled program instances accept memory from another realm", () => {
  const memory = runInNewContext(
    "new WebAssembly.Memory({ initial: 1 })"
  ) as WebAssembly.Memory;

  new DataView(memory.buffer).setUint32(0, 42, true);
  const instance = instantiateCompiledProgram(
    fixture.compiled,
    {
      memories: new Map([[fixture.resource, memory]]),
      functions: new Map([[fixture.functionRef, (value: number) => value]])
    }
  );
  const run = instance.functionExports.get(fixture.exportRef);

  strictEqual(typeof run, "function");
  strictEqual((run as () => number)(), 42);
});

test("compiled program instances reject undersized memory before instantiation", () => {
  const undersizedFixture = createInstanceFixture({ minPages: 2 });
  const memory = new WebAssembly.Memory({ initial: 1 });

  throws(
    () => instantiateCompiledProgram(
      undersizedFixture.compiled,
      {
        memories: new Map([[undersizedFixture.resource, memory]]),
        functions: new Map([[undersizedFixture.functionRef, () => 42]])
      }
    ),
    /memory binding for program resource test\.instance\.memory is smaller than its declared minimum/
  );
});

test("compiled program instances do not resolve a same-ID foreign export ref", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const instance = instantiateCompiledProgram(
    fixture.compiled,
    {
      memories: new Map([[fixture.resource, memory]]),
      functions: new Map([[fixture.functionRef, () => 42]])
    }
  );
  const foreignExport = functionExportRef(fixture.exportRef.id);

  strictEqual(instance.functionExports.get(foreignExport), undefined);
});

type InstanceFixture = Readonly<{
  compiled: CompiledProgram;
  resource: ResourceRef;
  functionRef: FunctionRef;
  exportRef: FunctionExportRef;
}>;

function createInstanceFixture(
  options: Readonly<{ minPages?: number }> = {}
): InstanceFixture {
  const resource = resourceRef("test.instance.memory");
  const resources = createProgramResources([{
    ref: resource,
    moduleName: "external runtime/2026",
    name: "memory.with punctuation",
    limits: { minPages: options.minPages ?? 1 }
  }]);
  const program = new ProgramBuilder(resources);
  const access = memoryRead(resource);
  const imported = program.importFunction({
    ref: functionRef("test.instance.function"),
    type: functionType(["i32"], ["i32"]),
    effects: { reads: [], writes: [] },
    moduleName: "external runtime/2026",
    name: "function.with punctuation"
  });
  const entry = program.defineFunction({
    ref: functionRef("test.instance.entry"),
    type: functionType([], ["i32"]),
    effects: { reads: [access], writes: [] }
  }, (fn) => {
    const value = fn.region.operation(resourceRead, {
      source: memoryOperand(resource, access, fn.values.const(0))
    });
    const result = fn.region.call(imported, [value])[0];

    if (result === undefined) {
      throw new Error("missing imported function result");
    }
    fn.return([result]);
  });
  const exportRef = functionExportRef("test.instance.entry-export");

  program.exportFunction({
    ref: exportRef,
    name: "run.with punctuation",
    target: entry.ref
  });
  return {
    compiled: compileProgram(program.finish()),
    resource,
    functionRef: imported.ref,
    exportRef
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
