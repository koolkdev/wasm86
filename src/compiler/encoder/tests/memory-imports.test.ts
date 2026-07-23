import { strictEqual } from "node:assert";
import { test } from "node:test";

import { encodeWasmFunctionBody } from "#compiler/encoder/function-body.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-fixture.js";
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
        body: encodeWasmFunctionBody({
          parameterCount: 1,
          localTypes: []
        }, (writer) => {
          writer.localGet(0);
          writer.i32Const(0x1234_5678);
          writer.i32Store({
            align: 2,
            memoryIndex: 0,
            offset: 0
          });
        })
      },
      {
        typeIndex: 1,
        body: encodeWasmFunctionBody({
          parameterCount: 2,
          localTypes: []
        }, (writer) => {
          writer.localGet(0);
          writer.localGet(1);
          writer.i32Store({
            align: 2,
            memoryIndex: 1,
            offset: 0
          });
        })
      },
      {
        typeIndex: 2,
        body: encodeWasmFunctionBody({
          parameterCount: 1,
          localTypes: []
        }, (writer) => {
          writer.localGet(0);
          writer.i32Load({
            align: 2,
            memoryIndex: 1,
            offset: 0
          });
        })
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
