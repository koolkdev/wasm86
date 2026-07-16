import type { FieldRef } from "#compiler/layout/handles.js";
import type { Layout } from "#compiler/layout/layout.js";
import { u32 } from "#core/numeric.js";
import type { X86Flag } from "./definitions.js";
import { flagStateFields } from "./state.js";

export interface FlagStateHostView {
  lazyKind: number;
  lazyA: number;
  lazyB: number;

  readFlag(flag: X86Flag): boolean;
  writeFlag(flag: X86Flag, value: boolean): void;
  readFlagByte(flag: X86Flag): number;
  writeFlagByte(flag: X86Flag, value: number): void;
}

export function createFlagStateHostView(
  memory: WebAssembly.Memory,
  layout: Layout
): FlagStateHostView {
  return new FlagStateHostViewImpl(memory, layout);
}

class FlagStateHostViewImpl implements FlagStateHostView {
  readonly #memory: WebAssembly.Memory;
  readonly #layout: Layout;

  constructor(
    memory: WebAssembly.Memory,
    layout: Layout
  ) {
    this.#memory = memory;
    this.#layout = layout;
  }

  get lazyKind(): number {
    return this.#read(flagStateFields.lazyKind);
  }

  set lazyKind(value: number) {
    this.#write(flagStateFields.lazyKind, value);
  }

  get lazyA(): number {
    return this.#read(flagStateFields.lazyA);
  }

  set lazyA(value: number) {
    this.#write(flagStateFields.lazyA, value);
  }

  get lazyB(): number {
    return this.#read(flagStateFields.lazyB);
  }

  set lazyB(value: number) {
    this.#write(flagStateFields.lazyB, value);
  }

  readFlag(flag: X86Flag): boolean {
    return this.readFlagByte(flag) !== 0;
  }

  writeFlag(flag: X86Flag, value: boolean): void {
    this.writeFlagByte(flag, value ? 1 : 0);
  }

  readFlagByte(flag: X86Flag): number {
    return this.#read(flagStateFields.concrete[flag]);
  }

  writeFlagByte(flag: X86Flag, value: number): void {
    this.#write(flagStateFields.concrete[flag], value === 0 ? 0 : 1);
  }

  #read(field: FieldRef): number {
    const resolved = this.#layout.field(field);
    const view = this.#view();

    switch (resolved.byteLength) {
      case 1:
        return view.getUint8(resolved.offset);
      case 2:
        return view.getUint16(resolved.offset, true);
      case 4:
        return view.getUint32(resolved.offset, true);
    }
  }

  #write(field: FieldRef, value: number): void {
    const resolved = this.#layout.field(field);
    const view = this.#view();

    switch (resolved.byteLength) {
      case 1:
        view.setUint8(resolved.offset, u32(value) & 0xff);
        return;
      case 2:
        view.setUint16(resolved.offset, u32(value) & 0xffff, true);
        return;
      case 4:
        view.setUint32(resolved.offset, u32(value), true);
        return;
    }
  }

  #view(): DataView<ArrayBuffer> {
    return new DataView(this.#memory.buffer);
  }
}
