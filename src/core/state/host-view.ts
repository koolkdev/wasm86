import { assert } from "#common/assert.js";
import type { ArrayRef, FieldRef } from "#compiler/layout/handles.js";
import type { Layout } from "#compiler/layout/layout.js";
import { u32 } from "#core/numeric.js";
import type { Reg32, SegmentRegister } from "#core/types.js";
import { coreStateFields } from "./fields.js";

export interface CoreStateHostView {
  eip: number;

  readReg32(reg: Reg32): number;
  writeReg32(reg: Reg32, value: number): void;
  readSegmentSelector(reg: SegmentRegister): number;
  writeSegmentSelector(reg: SegmentRegister, value: number): void;
  readSegmentBase(reg: SegmentRegister): number;
  writeSegmentBase(reg: SegmentRegister, value: number): void;
  readSegmentLimit(reg: SegmentRegister): number;
  writeSegmentLimit(reg: SegmentRegister, value: number): void;
  readSegmentAccess(reg: SegmentRegister): number;
  writeSegmentAccess(reg: SegmentRegister, value: number): void;
}

export function createCoreStateHostView(
  memory: WebAssembly.Memory,
  layout: Layout
): CoreStateHostView {
  return new CoreStateHostViewImpl(memory, layout);
}

class CoreStateHostViewImpl implements CoreStateHostView {
  readonly #memory: WebAssembly.Memory;
  readonly #layout: Layout;

  constructor(
    memory: WebAssembly.Memory,
    layout: Layout
  ) {
    this.#memory = memory;
    this.#layout = layout;
  }

  get eip(): number {
    return this.#readField(coreStateFields.eip);
  }

  set eip(value: number) {
    this.#writeField(coreStateFields.eip, value);
  }

  readReg32(reg: Reg32): number {
    return this.#readArrayElement(coreStateFields.gprs, reg);
  }

  writeReg32(reg: Reg32, value: number): void {
    this.#writeArrayElement(coreStateFields.gprs, reg, value);
  }

  readSegmentSelector(reg: SegmentRegister): number {
    return this.#readArrayElement(coreStateFields.segmentSelectors, reg);
  }

  writeSegmentSelector(reg: SegmentRegister, value: number): void {
    this.#writeArrayElement(coreStateFields.segmentSelectors, reg, value);
  }

  readSegmentBase(reg: SegmentRegister): number {
    return this.#readArrayElement(coreStateFields.segmentBases, reg);
  }

  writeSegmentBase(reg: SegmentRegister, value: number): void {
    this.#writeArrayElement(coreStateFields.segmentBases, reg, value);
  }

  readSegmentLimit(reg: SegmentRegister): number {
    return this.#readArrayElement(coreStateFields.segmentLimits, reg);
  }

  writeSegmentLimit(reg: SegmentRegister, value: number): void {
    this.#writeArrayElement(coreStateFields.segmentLimits, reg, value);
  }

  readSegmentAccess(reg: SegmentRegister): number {
    return this.#readArrayElement(coreStateFields.segmentAccess, reg);
  }

  writeSegmentAccess(reg: SegmentRegister, value: number): void {
    this.#writeArrayElement(coreStateFields.segmentAccess, reg, value);
  }

  #readField(field: FieldRef): number {
    const resolved = this.#layout.field(field);

    return readUnsigned(this.#view(), resolved.offset, resolved.byteLength);
  }

  #writeField(field: FieldRef, value: number): void {
    const resolved = this.#layout.field(field);

    writeUnsigned(this.#view(), resolved.offset, resolved.byteLength, value);
  }

  #readArrayElement<TElementId extends string>(
    array: ArrayRef<"u16" | "u32", TElementId>,
    elementId: TElementId
  ): number {
    const resolved = this.#layout.array(array);
    const index = array.elementIndex(elementId);

    assert(index < resolved.count, `array index ${index} is outside ${array.id}`);
    return readUnsigned(
      this.#view(),
      resolved.offset + index * resolved.stride,
      resolved.elementByteLength
    );
  }

  #writeArrayElement<TElementId extends string>(
    array: ArrayRef<"u16" | "u32", TElementId>,
    elementId: TElementId,
    value: number
  ): void {
    const resolved = this.#layout.array(array);
    const index = array.elementIndex(elementId);

    assert(index < resolved.count, `array index ${index} is outside ${array.id}`);
    writeUnsigned(
      this.#view(),
      resolved.offset + index * resolved.stride,
      resolved.elementByteLength,
      value
    );
  }

  #view(): DataView<ArrayBuffer> {
    return new DataView(this.#memory.buffer);
  }
}

function readUnsigned(view: DataView, offset: number, byteLength: 1 | 2 | 4): number {
  switch (byteLength) {
    case 1:
      return view.getUint8(offset);
    case 2:
      return view.getUint16(offset, true);
    case 4:
      return view.getUint32(offset, true);
  }
}

function writeUnsigned(
  view: DataView,
  offset: number,
  byteLength: 1 | 2 | 4,
  value: number
): void {
  switch (byteLength) {
    case 1:
      view.setUint8(offset, u32(value) & 0xff);
      return;
    case 2:
      view.setUint16(offset, u32(value) & 0xffff, true);
      return;
    case 4:
      view.setUint32(offset, u32(value), true);
      return;
  }
}
