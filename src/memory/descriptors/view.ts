import { assert } from "#common/assert.js";
import {
  descriptorFields,
  descriptorRecordOffset,
  descriptorTableByteLength,
  validateDescriptor,
  type DescriptorRecord
} from "#memory/descriptors/layout.js";

// Host view over private normalized descriptor authority. Guest-visible x86
// GDT/LDT bytes require a separate decoder and architectural load-time faults.
export class DescriptorTableView {
  constructor(readonly memory: WebAssembly.Memory) {
    assert(
      !(memory.buffer instanceof SharedArrayBuffer),
      "shared descriptor memory requires an atomic publication protocol"
    );
    if (memory.buffer.byteLength < descriptorTableByteLength) {
      throw new RangeError(
        `descriptor memory is too small: ${memory.buffer.byteLength} < ${descriptorTableByteLength}`
      );
    }
  }

  readDescriptor(selector: number): DescriptorRecord | undefined {
    const offset = this.#descriptorOffset(selector);
    const view = this.#view();
    const descriptor = {
      attrs: view.getUint32(offset + descriptorFields.attrs, true),
      base: view.getUint32(offset + descriptorFields.base, true),
      limit: view.getUint32(offset + descriptorFields.limit, true),
      reserved: view.getUint32(offset + descriptorFields.reserved, true)
    };

    assert(validateDescriptor(descriptor), "stored descriptor is invalid");
    return descriptor.attrs === 0 ? undefined : descriptor;
  }

  writeDescriptor(selector: number, descriptor: DescriptorRecord): void {
    const offset = this.#descriptorOffset(selector);

    // Validate the complete record before publishing any of its words.
    if (!validateDescriptor(descriptor)) {
      throw new RangeError("invalid descriptor");
    }

    const view = this.#view();

    view.setUint32(offset + descriptorFields.attrs, descriptor.attrs, true);
    view.setUint32(offset + descriptorFields.base, descriptor.base, true);
    view.setUint32(offset + descriptorFields.limit, descriptor.limit, true);
    view.setUint32(offset + descriptorFields.reserved, descriptor.reserved, true);
  }

  clearDescriptor(selector: number): void {
    const offset = this.#descriptorOffset(selector);
    const view = this.#view();

    view.setUint32(offset + descriptorFields.attrs, 0, true);
    view.setUint32(offset + descriptorFields.base, 0, true);
    view.setUint32(offset + descriptorFields.limit, 0, true);
    view.setUint32(offset + descriptorFields.reserved, 0, true);
  }

  #descriptorOffset(selector: number): number {
    if (!Number.isInteger(selector) || selector < 0 || selector > 0xffff) {
      throw new RangeError(`descriptor selector must be a u16: ${selector}`);
    }

    return descriptorRecordOffset(selector);
  }

  #view(): DataView<ArrayBuffer> {
    return new DataView(this.memory.buffer);
  }
}
