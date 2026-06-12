import type { StateChannel } from "#ir/action/slots.js";
import type { X86Flag } from "#x86/flags.js";
import { type CpuState } from "#x86/state/cpu-state.js";
import {
  readWasmCpuState,
  readWasmFlagByte,
  readWasmStateChannel,
  readWasmStateField,
  writeWasmCpuState,
  writeWasmFlagByte,
  writeWasmStateChannel,
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

  readChannel(channel: StateChannel): number {
    return readWasmStateChannel(this.#view(), channel);
  }

  writeChannel(channel: StateChannel, value: number): void {
    writeWasmStateChannel(this.#view(), channel, value);
  }

  readFlagByte(flag: X86Flag): number {
    return readWasmFlagByte(this.#view(), flag);
  }

  writeFlagByte(flag: X86Flag, value: number): void {
    writeWasmFlagByte(this.#view(), flag, value);
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
