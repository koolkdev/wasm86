import { decodeExit, type DecodedExit } from "#wasm/exit.js";
import { bindWasmInterpreter, type WasmInterpreterBinding } from "./binding.js";

export type WasmInterpreterRuntimeOptions = Readonly<{
  cpuStateMemory?: WebAssembly.Memory;
}>;

export class WasmInterpreterRuntime {
  readonly guestMemory: WebAssembly.Memory;
  readonly cpuStateMemory: WebAssembly.Memory;
  readonly stateView: DataView<ArrayBuffer>;
  readonly #interpreter: WasmInterpreterBinding;

  constructor(guestMemory: WebAssembly.Memory, options: WasmInterpreterRuntimeOptions = {}) {
    this.guestMemory = guestMemory;
    this.cpuStateMemory = options.cpuStateMemory ?? new WebAssembly.Memory({ initial: 1 });
    this.stateView = new DataView(this.cpuStateMemory.buffer);

    this.#interpreter = bindWasmInterpreter(
      this.guestMemory,
      this.cpuStateMemory
    );
  }

  run(fuel: number): DecodedExit {
    return decodeExit(this.#interpreter.run(fuel));
  }
}
