import { assert } from "#common/assert.js";
import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { instructionLimitField } from "#cpu/instruction-count.js";
import {
  cpuState,
  cpuStateResourceDefinition
} from "#cpu/state.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { guestMemoryResourceDefinition } from "#memory/resource.js";
import { encodeInterpreterModule } from "./module.js";
import { interpreterRunExportName } from "./program.js";

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
    [programImportModuleName]: {
      [cpuStateResourceDefinition.name]: cpuStateMemory,
      [guestMemoryResourceDefinition.name]: guestMemory
    }
  });
  const entry = instance.exports[interpreterRunExportName];
  const state = createLayoutHostView(cpuStateMemory, cpuState.layout);

  assert(
    typeof entry === "function",
    `expected exported function '${interpreterRunExportName}'`
  );
  return {
    setInstructionLimit(limit: number): void {
      state.writeField(instructionLimitField, limit);
    },
    run: entry as () => bigint
  };
}
