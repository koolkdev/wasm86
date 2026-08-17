import { strictEqual } from "node:assert";
import { test } from "node:test";

import { encodeWasmFunctionBody } from "#wasm/encoder/function-body.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import { encodeTestModule } from "#wasm/encoder/tests/module-fixture.js";

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
      { parameters: ["i32"], results: [] },
      { parameters: ["i32", "i32"], results: [] },
      { parameters: ["i32"], results: ["i32"] }
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
        body: encodeWasmFunctionBody(
          {
            parameterCount: 1,
            localTypes: []
          },
          (writer) => {
            writer.write(wasmInstruction.local.get, 0);
            writer.write(wasmInstruction.i32.const, 0x1234_5678);
            writer.write(wasmInstruction.i32.store, {
              align: 2,
              memoryIndex: 0,
              offset: 0
            });
          }
        )
      },
      {
        typeIndex: 1,
        body: encodeWasmFunctionBody(
          {
            parameterCount: 2,
            localTypes: []
          },
          (writer) => {
            writer.write(wasmInstruction.local.get, 0);
            writer.write(wasmInstruction.local.get, 1);
            writer.write(wasmInstruction.i32.store, {
              align: 2,
              memoryIndex: 1,
              offset: 0
            });
          }
        )
      },
      {
        typeIndex: 2,
        body: encodeWasmFunctionBody(
          {
            parameterCount: 1,
            localTypes: []
          },
          (writer) => {
            writer.write(wasmInstruction.local.get, 0);
            writer.write(wasmInstruction.i32.load, {
              align: 2,
              memoryIndex: 1,
              offset: 0
            });
          }
        )
      }
    ],
    functionExports: [
      { name: "storeCpuState", functionIndex: 0 },
      { name: "storeGuest", functionIndex: 1 },
      { name: "loadGuest", functionIndex: 2 }
    ]
  });
}

function readExportedFunction(
  instance: WebAssembly.Instance,
  name: string
): (...args: number[]) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (...args: number[]) => unknown;
}
