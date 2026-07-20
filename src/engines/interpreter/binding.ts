import { assert } from "#common/assert.js";
import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { instructionLimitField } from "#cpu/instruction-count.js";
import { cpuState } from "#cpu/state.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { encodeInterpreterModule } from "./module.js";

export type InterpreterBinding = Readonly<{
  setInstructionLimit(limit: number): void;
  run: () => bigint;
}>;

export type InterpreterBindingOptions = Readonly<{
  guestMemory: WebAssembly.Memory;
  cpuStateMemory: WebAssembly.Memory;
}>;

let compiledInterpreterModule: WebAssembly.Module | undefined;

export function bindInterpreter({
  guestMemory,
  cpuStateMemory
}: InterpreterBindingOptions): InterpreterBinding {
  compiledInterpreterModule ??= new WebAssembly.Module(encodeInterpreterModule());

  const instance = new WebAssembly.Instance(compiledInterpreterModule, {
    [wasmImport.namespace]: {
      [wasmImport.cpuStateMemoryName]: cpuStateMemory,
      [wasmImport.guestMemoryName]: guestMemory
    }
  });
  const entry = instance.exports[wasmBlockExportName];
  const state = createLayoutHostView(cpuStateMemory, cpuState.layout);

  assert(typeof entry === "function", `expected exported function '${wasmBlockExportName}'`);
  return {
    setInstructionLimit(limit: number): void {
      state.writeField(instructionLimitField, limit);
    },
    run: entry as () => bigint
  };
}
