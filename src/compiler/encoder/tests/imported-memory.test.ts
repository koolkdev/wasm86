import { strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { encodeMemoryImmediate } from "#compiler/encoder/memory.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-description.js";
import { wasmValueType } from "#compiler/encoder/types.js";

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
  return encodeTestModule({
    functionTypes: [
      { params: [wasmValueType.i32], results: [] },
      { params: [wasmValueType.i32, wasmValueType.i32], results: [] },
      { params: [wasmValueType.i32], results: [wasmValueType.i32] }
    ],
    memoryImports: [
      {
        moduleName: importNamespace,
        name: cpuStateImportName,
        limits: { minPages: 1 }
      },
      {
        moduleName: importNamespace,
        name: guestImportName,
        limits: { minPages: 1 }
      }
    ],
    functions: [
      {
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder()
          .localGet(0)
          .i32Const(0x1234_5678)
          .i32Store({
            align: 2,
            memoryIndex: 0,
            offset: 0
          })
          .finish()
      },
      {
        typeIndex: 1,
        body: new WasmFunctionBodyEncoder()
          .localGet(0)
          .localGet(1)
          .i32Store({
            align: 2,
            memoryIndex: 1,
            offset: 0
          })
          .finish()
      },
      {
        typeIndex: 2,
        body: new WasmFunctionBodyEncoder()
          .localGet(0)
          .i32Load({
            align: 2,
            memoryIndex: 1,
            offset: 0
          })
          .finish()
      }
    ],
    functionExports: [
      { name: "storeCpuState", functionIndex: 0 },
      { name: "storeGuest", functionIndex: 1 },
      { name: "loadGuest", functionIndex: 2 }
    ]
  });
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
