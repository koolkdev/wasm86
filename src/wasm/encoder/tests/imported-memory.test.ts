import { strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { encodeMemoryImmediate } from "#wasm/encoder/memory.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";

const importNamespace = "wasm86";
const cpuStateImportName = "cpuState";
const guestImportName = "guest";

test("cpu state memory is index 0", async () => {
  const bytes = encodeImportedMemoryTestModule();
  const state = new WebAssembly.Memory({ initial: 1 });
  const guest = new WebAssembly.Memory({ initial: 1 });
  const instance = await instantiateImportedMemoryTestModule(bytes, state, guest);
  const storeCpuState = readExportedFunction(instance, "storeCpuState");

  storeCpuState(0);

  strictEqual(new DataView(state.buffer).getUint32(0, true), 0x1234_5678);
  strictEqual(new DataView(guest.buffer).getUint32(0, true), 0);
});

test("guest memory is index 1", async () => {
  const bytes = encodeImportedMemoryTestModule();
  const state = new WebAssembly.Memory({ initial: 1 });
  const guest = new WebAssembly.Memory({ initial: 1 });
  const instance = await instantiateImportedMemoryTestModule(bytes, state, guest);
  const storeGuest = readExportedFunction(instance, "storeGuest");
  const loadGuest = readExportedFunction(instance, "loadGuest");

  storeGuest(4, 0x1234_5678);

  strictEqual(new DataView(guest.buffer).getUint32(4, true), 0x1234_5678);
  strictEqual(loadGuest(4), 0x1234_5678);
  strictEqual(new DataView(state.buffer).getUint32(4, true), 0);
});

test("memory import order is stable", () => {
  const module = new WasmModuleEncoder();
  const cpuStateMemoryIndex = module.importMemory(importNamespace, cpuStateImportName, { minPages: 1 });
  const guestMemoryIndex = module.importMemory(importNamespace, guestImportName, { minPages: 1 });

  strictEqual(cpuStateMemoryIndex, 0);
  strictEqual(guestMemoryIndex, 1);
});

test("indexed memory immediate encodes memory 1", () => {
  strictEqual(
    bytesToHex(
      encodeMemoryImmediate({
        align: 2,
        memoryIndex: 1,
        offset: 0
      })
    ),
    "42 01 00"
  );
});

async function instantiateImportedMemoryTestModule(
  bytes: Uint8Array<ArrayBuffer>,
  state: WebAssembly.Memory,
  guest: WebAssembly.Memory
): Promise<WebAssembly.Instance> {
  const module = await WebAssembly.compile(bytes);
  return WebAssembly.instantiate(module, {
    [importNamespace]: {
      [cpuStateImportName]: state,
      [guestImportName]: guest
    }
  });
}

function encodeImportedMemoryTestModule(): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const cpuStateMemoryIndex = module.importMemory(importNamespace, cpuStateImportName, { minPages: 1 });
  const guestMemoryIndex = module.importMemory(importNamespace, guestImportName, { minPages: 1 });

  const storeCpuStateType = module.addFunctionType({
    params: [wasmValueType.i32],
    results: []
  });
  const storeGuestType = module.addFunctionType({
    params: [wasmValueType.i32, wasmValueType.i32],
    results: []
  });
  const loadGuestType = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i32]
  });

  const storeCpuState = module.addFunction(
    storeCpuStateType,
    new WasmFunctionBodyEncoder()
      .localGet(0)
      .i32Const(0x1234_5678)
      .i32Store({
        align: 2,
        memoryIndex: cpuStateMemoryIndex,
        offset: 0
      })
      .end()
  );
  const storeGuest = module.addFunction(
    storeGuestType,
    new WasmFunctionBodyEncoder()
      .localGet(0)
      .localGet(1)
      .i32Store({
        align: 2,
        memoryIndex: guestMemoryIndex,
        offset: 0
      })
      .end()
  );
  const loadGuest = module.addFunction(
    loadGuestType,
    new WasmFunctionBodyEncoder()
      .localGet(0)
      .i32Load({
        align: 2,
        memoryIndex: guestMemoryIndex,
        offset: 0
      })
      .end()
  );

  module.exportFunction("storeCpuState", storeCpuState);
  module.exportFunction("storeGuest", storeGuest);
  module.exportFunction("loadGuest", loadGuest);

  return module.encode();
}

function readExportedFunction(instance: WebAssembly.Instance, name: string): (...args: number[]) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (...args: number[]) => unknown;
}

function bytesToHex(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}
