import type { CpuState } from "#x86/state/cpu-state.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { decodeExit, type DecodedExit } from "#wasm/exit.js";
import { readWasmCpuState, writeWasmCpuState } from "#wasm/state-layout.js";
import { encodeInterpreterModule } from "./module.js";

let compiledInterpreterModule: WebAssembly.Module | undefined;

export type WasmInterpreterRuntimeOptions = Readonly<{
  stateMemory?: WebAssembly.Memory;
}>;

export class WasmInterpreterRuntime {
  readonly guestMemory: WebAssembly.Memory;
  readonly stateMemory: WebAssembly.Memory;
  readonly stateView: DataView<ArrayBuffer>;
  readonly #run: (fuel: number) => bigint;

  constructor(guestMemory: WebAssembly.Memory, options: WasmInterpreterRuntimeOptions = {}) {
    this.guestMemory = guestMemory;
    this.stateMemory = options.stateMemory ?? new WebAssembly.Memory({ initial: 1 });
    this.stateView = new DataView(this.stateMemory.buffer);

    const instance = new WebAssembly.Instance(compiledModule(), {
      [wasmImport.moduleName]: {
        [wasmImport.stateMemoryName]: this.stateMemory,
        [wasmImport.guestMemoryName]: this.guestMemory
      }
    });

    this.#run = readRunExport(instance);
  }

  run(fuel: number): DecodedExit {
    return decodeExit(this.#run(fuel));
  }

  copyStateToWasm(state: CpuState): void {
    writeWasmCpuState(this.stateView, state);
  }

  // The interpreter writes flag bytes, never the packed word.
  copyStateFromWasm(state: CpuState): void {
    Object.assign(state, readWasmCpuState(this.stateView, "bytes"));
  }
}

function compiledModule(): WebAssembly.Module {
  compiledInterpreterModule ??= new WebAssembly.Module(encodeInterpreterModule().bytes);
  return compiledInterpreterModule;
}

function readRunExport(instance: WebAssembly.Instance): (fuel: number) => bigint {
  const exported = instance.exports[wasmBlockExportName];

  if (typeof exported !== "function") {
    throw new Error(`expected exported function '${wasmBlockExportName}'`);
  }

  return exported as (fuel: number) => bigint;
}
