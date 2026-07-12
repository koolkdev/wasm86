import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmValueType } from "#compiler/encoder/types.js";
import { decodeExit, encodeHostExit, HostExit } from "#wasm/exit.js";

const entryExportName = "entry";
const cpuStatePtr = 32;

test("writer_emits_two_internal_functions", async () => {
  const module = await WebAssembly.compile(encodeTwoFunctionModule());

  ok(module instanceof WebAssembly.Module);
});

test("exported_entry_calls_internal_function", async () => {
  const instance = await instantiateTwoFunctionModule();
  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  deepStrictEqual(decodeExit(result), {
    family: "host",
    reason: HostExit.TRAP,
    payload: 0x2e
  });
});

test("function_indexes_are_stable", () => {
  const module = new WasmModuleEncoder();
  const blockType = addBlockFunctionType(module);
  const helperIndex = module.addFunction(blockType, helperBody());
  const entryIndex = module.addFunction(blockType, entryBody(helperIndex));

  strictEqual(helperIndex, 0);
  strictEqual(entryIndex, 1);
});

test("structurally equal function types share an index", () => {
  const module = new WasmModuleEncoder();
  const first = addBlockFunctionType(module);
  const second = addBlockFunctionType(module);

  strictEqual(second, first);
});

test("cpu_state_memory_import_still_memory_0", () => {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(encodeTwoFunctionModule()));

  deepStrictEqual(imports[0], {
    module: wasmImport.namespace,
    name: wasmImport.cpuStateMemoryName,
    kind: "memory"
  });
});

test("guest_memory_import_still_memory_1", () => {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(encodeTwoFunctionModule()));

  deepStrictEqual(imports[1], {
    module: wasmImport.namespace,
    name: wasmImport.guestMemoryName,
    kind: "memory"
  });
});

async function instantiateTwoFunctionModule(): Promise<WebAssembly.Instance> {
  const module = await WebAssembly.compile(encodeTwoFunctionModule());
  const cpuStateMemory = new WebAssembly.Memory({ initial: 1 });
  const guestMemory = new WebAssembly.Memory({ initial: 1 });
  const instance = await WebAssembly.instantiate(module, {
    [wasmImport.namespace]: {
      [wasmImport.cpuStateMemoryName]: cpuStateMemory,
      [wasmImport.guestMemoryName]: guestMemory
    }
  });

  return instance;
}

function encodeTwoFunctionModule(): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const cpuStateMemoryIndex = module.importMemory(wasmImport.namespace, wasmImport.cpuStateMemoryName, { minPages: 1 });
  const guestMemoryIndex = module.importMemory(wasmImport.namespace, wasmImport.guestMemoryName, { minPages: 1 });

  strictEqual(cpuStateMemoryIndex, wasmMemoryIndex.cpuState);
  strictEqual(guestMemoryIndex, wasmMemoryIndex.guest);

  const blockType = addBlockFunctionType(module);
  const helperIndex = module.addFunction(blockType, helperBody());
  const entryIndex = module.addFunction(blockType, entryBody(helperIndex));

  module.exportFunction(entryExportName, entryIndex);

  return module.encode();
}

function addBlockFunctionType(module: WasmModuleEncoder): number {
  return module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i64]
  });
}

function helperBody(): WasmFunctionBodyEncoder {
  return new WasmFunctionBodyEncoder(1)
    .i64Const(encodeHostExit(HostExit.TRAP, 0x2e))
    .end();
}

function entryBody(targetFunctionIndex: number): WasmFunctionBodyEncoder {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .callFunction(targetFunctionIndex)
    .end();
}

function exportedFunction(instance: WebAssembly.Instance, name: string): (cpuStatePtr: number) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (cpuStatePtr: number) => unknown;
}
