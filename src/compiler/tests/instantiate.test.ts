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
import { functionRef } from "#compiler/ir/refs.js";
import { createProgramResources } from "#compiler/program/resources.js";

const fixture = createInstanceFixture();

test("compiled program instances bind arbitrary external names and resolve exact exports", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });

  new DataView(memory.buffer).setUint32(0, 42, true);
  const instance = instantiateCompiledProgram(
    fixture.compiled,
    {
      memories: new Map([[fixture.resource, memory]]),
      functions: new Map()
    }
  );
  const read = instance.functionExports.get(fixture.exportRef);

  strictEqual(typeof read, "function");
  strictEqual((read as () => number)(), 42);
});

test("compiled program instances reject a missing memory binding", () => {
  throws(
    () => instantiateCompiledProgram(fixture.compiled, {
      memories: new Map(),
      functions: new Map()
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
        functions: new Map()
      }
    ),
    /missing memory binding for program resource test\.instance\.memory/
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
      functions: new Map()
    }
  );
  const read = instance.functionExports.get(fixture.exportRef);

  strictEqual(typeof read, "function");
  strictEqual((read as () => number)(), 42);
});

test("compiled program instances reject undersized memory before instantiation", () => {
  const undersizedFixture = createInstanceFixture({ minPages: 2 });
  const memory = new WebAssembly.Memory({ initial: 1 });

  throws(
    () => instantiateCompiledProgram(
      undersizedFixture.compiled,
      {
        memories: new Map([[undersizedFixture.resource, memory]]),
        functions: new Map()
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
      functions: new Map()
    }
  );
  const foreignExport = functionExportRef(fixture.exportRef.id);

  strictEqual(instance.functionExports.get(foreignExport), undefined);
});

type InstanceFixture = Readonly<{
  compiled: CompiledProgram;
  resource: ResourceRef;
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
  const read = program.defineFunction({
    ref: functionRef("test.instance.read"),
    type: functionType([], ["i32"]),
    effects: { reads: [access], writes: [] }
  }, (fn) => {
    const value = fn.region.operation(resourceRead, {
      source: memoryOperand(resource, access, fn.values.const(0))
    });

    fn.return([value]);
  });
  const exportRef = functionExportRef("test.instance.read-export");

  program.exportFunction({
    ref: exportRef,
    name: "read.with punctuation",
    target: read.ref
  });
  return {
    compiled: compileProgram(program.finish()),
    resource,
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
