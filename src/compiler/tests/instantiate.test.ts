import { strictEqual } from "node:assert";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { type ResourceAccess } from "#compiler/function/resource.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import { resourceRef, type ResourceRef } from "#compiler/reference.js";
import { compileProgram, type CompiledProgram } from "#compiler/compile.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/function/type.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import { functionExportRef, type FunctionExportRef } from "#compiler/program/exports.js";
import { functionRef, type FunctionRef } from "#compiler/reference.js";
import { createProgramResources } from "#compiler/program/resources.js";
import { Integer, i32, type I32Value } from "#compiler/function/values.js";

const fixture = createInstanceFixture();

test("compiled program instances bind memory and functions in one external module", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });

  new DataView(memory.buffer).setUint32(0, 41, true);
  const instance = instantiateCompiledProgram(fixture.compiled, {
    memories: new Map([[fixture.resource, memory]]),
    functions: new Map([[fixture.functionRef, (value: number) => value + 1]])
  });
  const run = instance.functionExports.get(fixture.exportRef);

  strictEqual(typeof run, "function");
  strictEqual((run as () => number)(), 42);
});

test("compiled program instances accept memory from another realm", () => {
  const memory = runInNewContext("new WebAssembly.Memory({ initial: 1 })") as WebAssembly.Memory;

  new DataView(memory.buffer).setUint32(0, 42, true);
  const instance = instantiateCompiledProgram(fixture.compiled, {
    memories: new Map([[fixture.resource, memory]]),
    functions: new Map([[fixture.functionRef, (value: number) => value]])
  });
  const run = instance.functionExports.get(fixture.exportRef);

  strictEqual(typeof run, "function");
  strictEqual((run as () => number)(), 42);
});

type InstanceFixture = Readonly<{
  compiled: CompiledProgram;
  resource: ResourceRef;
  functionRef: FunctionRef;
  exportRef: FunctionExportRef;
}>;

function createInstanceFixture(): InstanceFixture {
  const resource = resourceRef("test.instance.memory");
  const resources = createProgramResources([
    {
      ref: resource,
      moduleName: "external runtime/2026",
      name: "memory.with punctuation",
      limits: { minPages: 1 }
    }
  ]);
  const program = new ProgramBuilder(resources);
  const access = memoryRead(resource);
  const imported = program.importFunction({
    ref: functionRef("test.instance.function"),
    type: functionType([Integer[32]], [Integer[32]]),
    effects: { reads: [], writes: [] },
    moduleName: "external runtime/2026",
    name: "function.with punctuation"
  });
  const entry = program.defineFunction(
    {
      ref: functionRef("test.instance.entry"),
      type: functionType([], [Integer[32]]),
      effects: { reads: [access], writes: [] }
    },
    (fn) => {
      const value = fn.region.readResource(memoryOperand(resource, access, i32(0)));
      const result = fn.region.call(imported, [value])[0];

      if (result === undefined) {
        throw new Error("missing imported function result");
      }
      fn.return([result]);
    }
  );
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
    kind: "resource",
    resource,
    range: { kind: "slice", origin: "resource", byteOffset: 0, byteLength: 4 }
  };
}

function memoryOperand(
  resource: ResourceRef,
  effect: ResourceEffect,
  base: I32Value
): ResourceAccess<32> {
  return {
    effect: { ...effect, resource },
    address: { base, displacement: 0 },
    storageWidth: 32,
    valueWidth: 32
  };
}
