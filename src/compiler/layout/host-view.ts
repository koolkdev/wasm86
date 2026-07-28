import { assert } from "#common/assert.js";
import type {
  ArrayRef,
  FieldRef,
  LayoutByteLength,
  LayoutWidth,
  NamedArrayRef
} from "./handles.js";
import type { Layout } from "./layout.js";

export interface LayoutHostView {
  readField<TWidth extends LayoutWidth>(field: FieldRef<TWidth>): number;
  writeField<TWidth extends LayoutWidth>(field: FieldRef<TWidth>, value: number): void;
  readNamedArrayElement<TWidth extends LayoutWidth, TElementId extends string>(
    array: NamedArrayRef<TWidth, TElementId>,
    elementId: TElementId
  ): number;
  writeNamedArrayElement<TWidth extends LayoutWidth, TElementId extends string>(
    array: NamedArrayRef<TWidth, TElementId>,
    elementId: TElementId,
    value: number
  ): void;
  readArrayElement(
    array: ArrayRef,
    index: number,
    byteOffset: number,
    byteLength: LayoutByteLength
  ): number;
  writeArrayElement(
    array: ArrayRef,
    index: number,
    byteOffset: number,
    byteLength: LayoutByteLength,
    value: number
  ): void;
}

export function createLayoutHostView(memory: WebAssembly.Memory, layout: Layout): LayoutHostView {
  if (memory.buffer.byteLength < layout.byteLength) {
    throw new RangeError(
      `${layout.space} memory is too small: ${memory.buffer.byteLength} < ${layout.byteLength}`
    );
  }

  return new LayoutHostViewImpl(memory, layout);
}

class LayoutHostViewImpl implements LayoutHostView {
  readonly #memory: WebAssembly.Memory;
  readonly #layout: Layout;

  constructor(memory: WebAssembly.Memory, layout: Layout) {
    this.#memory = memory;
    this.#layout = layout;
  }

  readField<TWidth extends LayoutWidth>(field: FieldRef<TWidth>): number {
    const resolved = this.#layout.field(field);

    return this.#read(resolved.offset, resolved.byteLength);
  }

  writeField<TWidth extends LayoutWidth>(field: FieldRef<TWidth>, value: number): void {
    const resolved = this.#layout.field(field);

    this.#write(resolved.offset, resolved.byteLength, value);
  }

  readNamedArrayElement<TWidth extends LayoutWidth, TElementId extends string>(
    array: NamedArrayRef<TWidth, TElementId>,
    elementId: TElementId
  ): number {
    const resolved = this.#layout.namedArray(array);
    const index = array.elementIndex(elementId);

    assert(index < resolved.count, `named array index ${index} is outside ${array.id}`);
    return this.#read(resolved.offset + index * resolved.stride, resolved.elementByteLength);
  }

  writeNamedArrayElement<TWidth extends LayoutWidth, TElementId extends string>(
    array: NamedArrayRef<TWidth, TElementId>,
    elementId: TElementId,
    value: number
  ): void {
    const resolved = this.#layout.namedArray(array);
    const index = array.elementIndex(elementId);

    assert(index < resolved.count, `named array index ${index} is outside ${array.id}`);
    this.#write(resolved.offset + index * resolved.stride, resolved.elementByteLength, value);
  }

  readArrayElement(
    array: ArrayRef,
    index: number,
    byteOffset: number,
    byteLength: LayoutByteLength
  ): number {
    return this.#read(this.#arrayElementOffset(array, index, byteOffset, byteLength), byteLength);
  }

  writeArrayElement(
    array: ArrayRef,
    index: number,
    byteOffset: number,
    byteLength: LayoutByteLength,
    value: number
  ): void {
    this.#write(this.#arrayElementOffset(array, index, byteOffset, byteLength), byteLength, value);
  }

  #arrayElementOffset(
    array: ArrayRef,
    index: number,
    byteOffset: number,
    byteLength: LayoutByteLength
  ): number {
    const resolved = this.#layout.array(array);

    assert(
      Number.isSafeInteger(index) && index >= 0 && index < resolved.count,
      `array index ${index} is outside ${array.id}`
    );
    assert(
      Number.isSafeInteger(byteOffset) &&
        byteOffset >= 0 &&
        byteOffset + byteLength <= resolved.elementByteLength,
      `array element access is outside ${array.id}`
    );
    return resolved.offset + index * resolved.stride + byteOffset;
  }

  #read(offset: number, byteLength: LayoutByteLength): number {
    const view = new DataView(this.#memory.buffer);

    switch (byteLength) {
      case 1:
        return view.getUint8(offset);
      case 2:
        return view.getUint16(offset, true);
      case 4:
        return view.getUint32(offset, true);
    }
  }

  #write(offset: number, byteLength: LayoutByteLength, value: number): void {
    assert(Number.isInteger(value), `layout write value must be an integer: ${value}`);

    const view = new DataView(this.#memory.buffer);

    switch (byteLength) {
      case 1:
        view.setUint8(offset, value);
        return;
      case 2:
        view.setUint16(offset, value, true);
        return;
      case 4:
        view.setUint32(offset, value, true);
        return;
    }
  }
}
