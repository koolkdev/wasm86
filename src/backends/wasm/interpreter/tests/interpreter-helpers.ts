import { strictEqual } from "node:assert";

import { type CpuState } from "#x86/state/cpu-state.js";
import { x86ArithmeticFlags } from "#x86/flags.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { decodeExit, type DecodedExit } from "#wasm/exit.js";
import {
  readWasmCpuState,
  readWasmFlagByte,
  readWasmStateField,
  WASM_STATE_FIELDS,
  writeWasmCpuState
} from "#wasm/state-layout.js";
import { createGuestMemory } from "#wasm/tests/helpers.js";

export type InterpreterModuleInstance = Readonly<{
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
  stateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
  stateView: DataView;
  guestView: DataView;
  run(fuel: number): DecodedExit;
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
  const stateMemory = new WebAssembly.Memory({ initial: 1 });
  const stateView = new DataView(stateMemory.buffer);
  const guestView = new DataView(guestMemory.buffer);
  const instance = await WebAssembly.instantiate(module, {
    [wasmImport.moduleName]: {
      [wasmImport.stateMemoryName]: stateMemory,
      [wasmImport.guestMemoryName]: guestMemory
    }
  });
  const run = readExportedRun(instance);

  return {
    module,
    instance,
    stateMemory,
    guestMemory,
    stateView,
    guestView,
    run: (fuel) => decodeExit(run(fuel))
  };
}

export function writeInterpreterState(view: DataView, state: CpuState): void {
  writeWasmCpuState(view, state);
}

export function readInterpreterState(view: DataView): CpuState {
  return readWasmCpuState(view);
}

export function assertInterpreterStateEquals(view: DataView, state: CpuState): void {
  const expectedView = new DataView(new ArrayBuffer(view.byteLength));

  writeWasmCpuState(expectedView, state);

  for (const field of WASM_STATE_FIELDS) {
    strictEqual(readWasmStateField(view, field), readWasmStateField(expectedView, field));
  }

  for (const flag of x86ArithmeticFlags) {
    strictEqual(readWasmFlagByte(view, flag), readWasmFlagByte(expectedView, flag));
  }
}

function readExportedRun(instance: WebAssembly.Instance): (fuel: number) => bigint {
  const value = instance.exports[wasmBlockExportName];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${wasmBlockExportName}'`);
  }

  return value as (fuel: number) => bigint;
}
