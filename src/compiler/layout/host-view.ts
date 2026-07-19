import { assert } from "#common/assert.js";
import type {
  ArrayRef,
  FieldRef,
  LayoutByteLength,
  LayoutWidth
} from "./handles.js";
import type { Layout } from "./layout.js";

export interface LayoutHostView {
  readField<TWidth extends LayoutWidth>(field: FieldRef<TWidth>): number;
  writeField<TWidth extends LayoutWidth>(
    field: FieldRef<TWidth>,
    value: number
  ): void;
  readArrayElement<
    TWidth extends LayoutWidth,
    TElementId extends string
  >(array: ArrayRef<TWidth, TElementId>, elementId: TElementId): number;
  writeArrayElement<
    TWidth extends LayoutWidth,
    TElementId extends string
  >(
    array: ArrayRef<TWidth, TElementId>,
    elementId: TElementId,
    value: number
  ): void;
}

export function createLayoutHostView(
  memory: WebAssembly.Memory,
  layout: Layout
): LayoutHostView {
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

  constructor(
    memory: WebAssembly.Memory,
    layout: Layout
  ) {
    this.#memory = memory;
    this.#layout = layout;
  }

  readField<TWidth extends LayoutWidth>(field: FieldRef<TWidth>): number {
    const resolved = this.#layout.field(field);

    return this.#read(resolved.offset, resolved.byteLength);
  }

  writeField<TWidth extends LayoutWidth>(
    field: FieldRef<TWidth>,
    value: number
  ): void {
    const resolved = this.#layout.field(field);

    this.#write(resolved.offset, resolved.byteLength, value);
  }

  readArrayElement<
    TWidth extends LayoutWidth,
    TElementId extends string
  >(array: ArrayRef<TWidth, TElementId>, elementId: TElementId): number {
    const resolved = this.#layout.array(array);
    const index = array.elementIndex(elementId);

    assert(index < resolved.count, `array index ${index} is outside ${array.id}`);
    return this.#read(
      resolved.offset + index * resolved.stride,
      resolved.elementByteLength
    );
  }

  writeArrayElement<
    TWidth extends LayoutWidth,
    TElementId extends string
  >(
    array: ArrayRef<TWidth, TElementId>,
    elementId: TElementId,
    value: number
  ): void {
    const resolved = this.#layout.array(array);
    const index = array.elementIndex(elementId);

    assert(index < resolved.count, `array index ${index} is outside ${array.id}`);
    this.#write(
      resolved.offset + index * resolved.stride,
      resolved.elementByteLength,
      value
    );
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
