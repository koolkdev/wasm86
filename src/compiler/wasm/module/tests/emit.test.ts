import { strictEqual } from "node:assert";
import { test } from "node:test";

import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { noStorageEffects } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import { Integer, type I32Value } from "#compiler/function/values.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef, resourceRef, type ResourceRef } from "#compiler/reference.js";
import { emitWasmModule } from "../emit.js";
import { indexWasmModule } from "../indices.js";
import type { WasmModulePlan } from "../plan.js";
import { plannedFunction } from "./function-plan-fixture.js";

test("module realization binds imported and defined functions and memories", async () => {
  const type = functionType([Integer[32]], [Integer[32]]);
  const inputMemory = resourceRef("test.wasm-module.emit.input-memory");
  const outputMemory = resourceRef("test.wasm-module.emit.output-memory");
  const inputEffect = effect(inputMemory);
  const outputEffect = effect(outputMemory);
  const imported: CallTarget<typeof type> = {
    kind: "direct",
    ref: functionRef("test.wasm-module.emit.transform"),
    type,
    effects: noStorageEffects
  };
  const helper: CallTarget<typeof type> = {
    kind: "direct",
    ref: functionRef("test.wasm-module.emit.helper"),
    type,
    effects: { reads: [inputEffect], writes: [] }
  };
  const entryRef = functionRef("test.wasm-module.emit.entry");
  const entry = plannedFunction(entryRef, type, (fn) => {
    const [address] = fn.parameters;
    const [loaded] = fn.region.call(helper, [address]);
    const [transformed] = fn.region.call(imported, [loaded]);

    fn.region.writeResource(access(outputEffect, address), transformed);
    fn.return([transformed]);
  });
  const load = plannedFunction(helper.ref, type, (fn) => {
    const [address] = fn.parameters;

    fn.return([fn.region.readResource(access(inputEffect, address))]);
  });
  const plan: WasmModulePlan = {
    // Reverse the semantic roles so a hard-coded memory zero is observable.
    memoryImports: [memoryImport(outputMemory, "output"), memoryImport(inputMemory, "input")],
    functionImports: [
      {
        ref: imported.ref,
        type: entry.type,
        moduleName: "env",
        name: "transform"
      }
    ],
    // The entry calls a definition that appears later in the function space.
    functions: [entry, load],
    exports: [
      {
        ref: functionExportRef("test.wasm-module.emit.entry-export"),
        name: "run",
        target: entryRef
      }
    ]
  };
  const bytes = emitWasmModule(plan, indexWasmModule(plan));
  const input = new WebAssembly.Memory({ initial: 1 });
  const output = new WebAssembly.Memory({ initial: 1 });
  let transformations = 0;

  new DataView(input.buffer).setInt32(0, 41, true);
  const instantiated = await WebAssembly.instantiate(bytes, {
    env: {
      input,
      output,
      transform(value: number): number {
        transformations += 1;
        return value + 1;
      }
    }
  });
  const run = instantiated.instance.exports.run;

  strictEqual(typeof run, "function");
  strictEqual((run as (address: number) => number)(0), 42);
  strictEqual(new DataView(output.buffer).getInt32(0, true), 42);
  strictEqual(new DataView(input.buffer).getInt32(0, true), 41);
  strictEqual(transformations, 1);
});

function memoryImport(ref: ResourceRef, name: string) {
  return {
    ref,
    moduleName: "env",
    name,
    limits: { minPages: 1 }
  } as const;
}

function access(effect: ResourceEffect, base: I32Value): ResourceAccess<32> {
  return {
    effect,
    address: { base, displacement: 0 },
    storageWidth: 32,
    valueWidth: 32
  };
}

function effect(resource: ResourceRef): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: { kind: "slice", origin: "resource", byteOffset: 0, byteLength: 4 }
  };
}
