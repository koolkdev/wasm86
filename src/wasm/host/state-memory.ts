import { type CpuState } from "#x86/state/cpu-state.js";
import {
  mergeWasmEflags,
  readWasmCpuState,
  readWasmStateField,
  splitEflagsForWasm,
  writeWasmCpuState,
  writeWasmStateField,
  WASM_STATE_BYTE_LENGTH,
  type WasmStateField
} from "#wasm/state-layout.js";

export class WasmCpuState {
  constructor(readonly memory: WebAssembly.Memory) {
    if (memory.buffer.byteLength < WASM_STATE_BYTE_LENGTH) {
      throw new RangeError(`state memory is too small: ${memory.buffer.byteLength} < ${WASM_STATE_BYTE_LENGTH}`);
    }
  }

  read(field: WasmStateField): number {
    return readWasmStateField(this.#view(), field);
  }

  write(field: WasmStateField, value: number): void {
    writeWasmStateField(this.#view(), field, value);
  }

  load(state: Partial<CpuState>): void {
    writeWasmCpuState(this.#view(), state);
  }

  snapshot(): CpuState {
    return readWasmCpuState(this.#view());
  }

  get eip(): number {
    return this.read("eip");
  }

  set eip(value: number) {
    this.write("eip", value);
  }

  get eflags(): number {
    return mergeWasmEflags(this.read("aluFlags"), this.read("ctrlFlags"));
  }

  set eflags(value: number) {
    const flags = splitEflagsForWasm(value);

    this.write("aluFlags", flags.aluFlags);
    this.write("ctrlFlags", flags.ctrlFlags);
  }

  get instructionCount(): number {
    return this.read("instructionCount");
  }

  get stopReason(): number {
    return this.read("stopReason");
  }

  #view(): DataView<ArrayBuffer> {
    return new DataView(this.memory.buffer);
  }
}
