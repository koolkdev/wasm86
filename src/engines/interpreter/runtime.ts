import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { decodeExit, type DecodedExit } from "#wasm/exit.js";
import { encodeInterpreterModule } from "./module.js";

let compiledInterpreterModule: WebAssembly.Module | undefined;

export type WasmInterpreterRuntimeOptions = Readonly<{
  cpuStateMemory?: WebAssembly.Memory;
}>;

export class WasmInterpreterRuntime {
  readonly guestMemory: WebAssembly.Memory;
  readonly cpuStateMemory: WebAssembly.Memory;
  readonly stateView: DataView<ArrayBuffer>;
  readonly #run: (fuel: number) => bigint;

  constructor(guestMemory: WebAssembly.Memory, options: WasmInterpreterRuntimeOptions = {}) {
    this.guestMemory = guestMemory;
    this.cpuStateMemory = options.cpuStateMemory ?? new WebAssembly.Memory({ initial: 1 });
    this.stateView = new DataView(this.cpuStateMemory.buffer);

    const instance = new WebAssembly.Instance(compiledModule(), {
      [wasmImport.namespace]: {
        [wasmImport.cpuStateMemoryName]: this.cpuStateMemory,
        [wasmImport.guestMemoryName]: this.guestMemory
      }
    });

    this.#run = readRunExport(instance);
  }

  run(fuel: number): DecodedExit {
    return decodeExit(this.#run(fuel));
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
