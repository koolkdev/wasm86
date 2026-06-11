import type { CpuState } from "#x86/state/cpu-state.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { decodeExit, type DecodedExit } from "#wasm/exit.js";
import { readWasmCpuState, writeWasmCpuState, type WasmFlagsRepresentation } from "#wasm/state-layout.js";
import { encodeActionInterpreterModule } from "./action/module.js";
import { readInterpreterWasmArtifact } from "./artifact.js";

// "static" is the prebuilt artifact and stays the default; "action" is the
// variant built on the action emitter. The variants disagree on where flags
// live in state memory, so the choice is exposed as flagsRepresentation.
export type WasmInterpreterVariant = "static" | "action";

const compiledInterpreterModules = new Map<WasmInterpreterVariant, WebAssembly.Module>();

export type WasmInterpreterRuntimeOptions = Readonly<{
  stateMemory?: WebAssembly.Memory;
  variant?: WasmInterpreterVariant;
}>;

export class WasmInterpreterRuntime {
  readonly guestMemory: WebAssembly.Memory;
  readonly stateMemory: WebAssembly.Memory;
  readonly stateView: DataView<ArrayBuffer>;
  readonly variant: WasmInterpreterVariant;
  readonly #run: (fuel: number) => bigint;

  constructor(guestMemory: WebAssembly.Memory, options: WasmInterpreterRuntimeOptions = {}) {
    this.guestMemory = guestMemory;
    this.stateMemory = options.stateMemory ?? new WebAssembly.Memory({ initial: 1 });
    this.stateView = new DataView(this.stateMemory.buffer);
    this.variant = options.variant ?? "static";

    const instance = new WebAssembly.Instance(compiledModule(this.variant), {
      [wasmImport.moduleName]: {
        [wasmImport.stateMemoryName]: this.stateMemory,
        [wasmImport.guestMemoryName]: this.guestMemory
      }
    });

    this.#run = readRunExport(instance);
  }

  get flagsRepresentation(): WasmFlagsRepresentation {
    return this.variant === "action" ? "bytes" : "packed";
  }

  run(fuel: number): DecodedExit {
    return decodeExit(this.#run(fuel));
  }

  copyStateToWasm(state: CpuState): void {
    writeWasmCpuState(this.stateView, state);
  }

  copyStateFromWasm(state: CpuState): void {
    Object.assign(state, readWasmCpuState(this.stateView, this.flagsRepresentation));
  }
}

function compiledModule(variant: WasmInterpreterVariant): WebAssembly.Module {
  const existing = compiledInterpreterModules.get(variant);

  if (existing !== undefined) {
    return existing;
  }

  const compiled = new WebAssembly.Module(moduleBytes(variant));

  compiledInterpreterModules.set(variant, compiled);
  return compiled;
}

function moduleBytes(variant: WasmInterpreterVariant): Uint8Array<ArrayBuffer> {
  switch (variant) {
    case "static":
      return readInterpreterWasmArtifact();
    case "action":
      return encodeActionInterpreterModule().bytes;
  }
}

function readRunExport(instance: WebAssembly.Instance): (fuel: number) => bigint {
  const exported = instance.exports[wasmBlockExportName];

  if (typeof exported !== "function") {
    throw new Error(`expected exported function '${wasmBlockExportName}'`);
  }

  return exported as (fuel: number) => bigint;
}
