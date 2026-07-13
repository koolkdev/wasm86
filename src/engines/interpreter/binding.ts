import { assert } from "#common/assert.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { encodeInterpreterModule } from "./module.js";

export type WasmInterpreterBinding = Readonly<{
  instance: WebAssembly.Instance;
  run: (fuel: number) => bigint;
}>;

let compiledInterpreterModule: WebAssembly.Module | undefined;

export function bindWasmInterpreter(
  guestMemory: WebAssembly.Memory,
  cpuStateMemory: WebAssembly.Memory
): WasmInterpreterBinding {
  compiledInterpreterModule ??= new WebAssembly.Module(encodeInterpreterModule().bytes);

  const instance = new WebAssembly.Instance(compiledInterpreterModule, {
    [wasmImport.namespace]: {
      [wasmImport.cpuStateMemoryName]: cpuStateMemory,
      [wasmImport.guestMemoryName]: guestMemory
    }
  });
  const entry = instance.exports[wasmBlockExportName];

  assert(typeof entry === "function", `expected exported function '${wasmBlockExportName}'`);
  return {
    instance,
    run: entry as (fuel: number) => bigint
  };
}
