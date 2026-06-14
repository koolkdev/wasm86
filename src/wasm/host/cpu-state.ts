import type { MutableCpuStateView } from "#x86/cpu-state.js";
import type { X86Flag } from "#x86/flags.js";
import type { Reg32 } from "#x86/types.js";
import { u32 } from "#x86/numeric.js";
import {
  WASM_CPU_FLAG_BYTE_OFFSETS,
  WASM_CPU_STATE_BYTE_LENGTH,
  WASM_CPU_STATE_FIELDS,
  WASM_CPU_STATE_LAYOUT,
  type WasmCpuStateField
} from "#wasm/cpu-state-layout.js";

export type WasmCpuStateSnapshot = Record<WasmCpuStateField, number>;
export type WasmCpuStateInit = Partial<WasmCpuStateSnapshot>;

export class WasmCpuState implements MutableCpuStateView {
  constructor(readonly memory: WebAssembly.Memory) {
    if (memory.buffer.byteLength < WASM_CPU_STATE_BYTE_LENGTH) {
      throw new RangeError(`cpu state memory is too small: ${memory.buffer.byteLength} < ${WASM_CPU_STATE_BYTE_LENGTH}`);
    }
  }

  readReg32(reg: Reg32): number {
    return this.#readField(this.#view(), reg);
  }

  writeReg32(reg: Reg32, value: number): void {
    this.#writeField(this.#view(), reg, value);
  }

  readFlag(flag: X86Flag): boolean {
    return this.#readFlagByte(this.#view(), flag) !== 0;
  }

  writeFlag(flag: X86Flag, value: boolean): void {
    this.#writeFlagByte(this.#view(), flag, value ? 1 : 0);
  }

  load(state: WasmCpuStateInit): void {
    const view = this.#view();

    for (const field of WASM_CPU_STATE_FIELDS) {
      this.#writeField(view, field, state[field] ?? 0);
    }
  }

  get eip(): number {
    return this.#readField(this.#view(), "eip");
  }

  set eip(value: number) {
    this.#writeField(this.#view(), "eip", value);
  }

  get instructionCount(): number {
    return this.#readField(this.#view(), "instructionCount");
  }

  #view(): DataView<ArrayBuffer> {
    return new DataView(this.memory.buffer);
  }

  #readField(view: DataView, field: WasmCpuStateField): number {
    const layout = WASM_CPU_STATE_LAYOUT[field];

    switch (layout.byteLength) {
      case 1:
        return view.getUint8(layout.offset);
      case 4:
        return view.getUint32(layout.offset, true);
    }
  }

  #writeField(view: DataView, field: WasmCpuStateField, value: number): void {
    const layout = WASM_CPU_STATE_LAYOUT[field];

    switch (layout.byteLength) {
      case 1:
        view.setUint8(layout.offset, value === 0 ? 0 : 1);
        break;
      case 4:
        view.setUint32(layout.offset, u32(value), true);
        break;
    }
  }

  #readFlagByte(view: DataView, flag: X86Flag): number {
    return view.getUint8(WASM_CPU_FLAG_BYTE_OFFSETS[flag]);
  }

  #writeFlagByte(view: DataView, flag: X86Flag, value: number): void {
    view.setUint8(WASM_CPU_FLAG_BYTE_OFFSETS[flag], value === 0 ? 0 : 1);
  }
}
