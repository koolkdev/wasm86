import { strictEqual } from "node:assert";

import {
  readWasmCpuStateSnapshot,
  readWasmCpuStateField,
  wasmCpuStateFields,
  writeWasmCpuStateSnapshot,
  type WasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import type { RunStop } from "#cpu/cpu.js";
import { decodeExit } from "#cpu/exit.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { createGuestMemory } from "#wasm/tests/helpers.js";

export type InterpreterModuleInstance = Readonly<{
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
  cpuStateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
  stateView: DataView;
  guestView: DataView;
  run(fuel: number): RunStop;
}>;

export async function instantiateInterpreterModule(
  bytes: Uint8Array<ArrayBuffer>,
  guestMemory: WebAssembly.Memory = createGuestMemory()
): Promise<InterpreterModuleInstance> {
  return instantiateInterpreterCompiledModule(new WebAssembly.Module(bytes), guestMemory);
}

export async function instantiateInterpreterCompiledModule(
  module: WebAssembly.Module,
  guestMemory: WebAssembly.Memory = createGuestMemory()
): Promise<InterpreterModuleInstance> {
  const cpuStateMemory = new WebAssembly.Memory({ initial: 1 });
  const stateView = new DataView(cpuStateMemory.buffer);
  const guestView = new DataView(guestMemory.buffer);
  const instance = await WebAssembly.instantiate(module, {
    [wasmImport.namespace]: {
      [wasmImport.cpuStateMemoryName]: cpuStateMemory,
      [wasmImport.guestMemoryName]: guestMemory
    }
  });
  const run = readExportedRun(instance);

  return {
    module,
    instance,
    cpuStateMemory,
    guestMemory,
    stateView,
    guestView,
    run: (fuel) => decodeExit(run(fuel))
  };
}

export function writeInterpreterState(view: DataView, state: WasmCpuStateSnapshot): void {
  writeWasmCpuStateSnapshot(view, state);
}

export function readInterpreterState(view: DataView): WasmCpuStateSnapshot {
  return readWasmCpuStateSnapshot(view);
}

export function assertInterpreterStateEquals(view: DataView, state: WasmCpuStateSnapshot): void {
  const expectedView = new DataView(new ArrayBuffer(view.byteLength));

  writeWasmCpuStateSnapshot(expectedView, state);

  for (const field of wasmCpuStateFields) {
    strictEqual(readWasmCpuStateField(view, field), readWasmCpuStateField(expectedView, field));
  }
}

function readExportedRun(instance: WebAssembly.Instance): (fuel: number) => bigint {
  const value = instance.exports[wasmBlockExportName];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${wasmBlockExportName}'`);
  }

  return value as (fuel: number) => bigint;
}
