import { assert } from "#common/assert.js";
import {
  DESCRIPTOR_ATTR,
  DESCRIPTOR_DEFINED_ATTR_MASK,
  DESCRIPTOR_RECORD_LAYOUT,
  DESCRIPTOR_TARGET_ATTR_MASK,
  MACHINE_FIXED_END,
  descriptorRecordOffset
} from "#wasm/machine-state-layout.js";

const maxU32 = 0xffff_ffff;

export type DescriptorRecord = Readonly<{
  attrs: number;
  base: number;
  limit: number;
  reserved: number;
}>;

export class MachineState {
  constructor(readonly memory: WebAssembly.Memory) {
    assert(
      !(memory.buffer instanceof SharedArrayBuffer),
      "shared machine memory requires an atomic publication protocol"
    );
    if (memory.buffer.byteLength < MACHINE_FIXED_END) {
      throw new RangeError(`machine memory is too small: ${memory.buffer.byteLength} < ${MACHINE_FIXED_END}`);
    }
  }

  readDescriptor(selector: number): DescriptorRecord | undefined {
    const offset = this.#descriptorOffset(selector);
    const view = this.#view();
    const descriptor = {
      attrs: view.getUint32(offset + DESCRIPTOR_RECORD_LAYOUT.attrs, true),
      base: view.getUint32(offset + DESCRIPTOR_RECORD_LAYOUT.base, true),
      limit: view.getUint32(offset + DESCRIPTOR_RECORD_LAYOUT.limit, true),
      reserved: view.getUint32(offset + DESCRIPTOR_RECORD_LAYOUT.reserved, true)
    };

    validateDescriptor(descriptor);
    return descriptor.attrs === 0 ? undefined : descriptor;
  }

  writeDescriptor(selector: number, descriptor: DescriptorRecord): void {
    const offset = this.#descriptorOffset(selector);

    // Validate the complete record before publishing any of its words.
    validateDescriptor(descriptor);

    const view = this.#view();

    view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.attrs, descriptor.attrs, true);
    view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.base, descriptor.base, true);
    view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.limit, descriptor.limit, true);
    view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.reserved, descriptor.reserved, true);
  }

  clearDescriptor(selector: number): void {
    const offset = this.#descriptorOffset(selector);
    const view = this.#view();

    view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.attrs, 0, true);
    view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.base, 0, true);
    view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.limit, 0, true);
    view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.reserved, 0, true);
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

function validateDescriptor(descriptor: DescriptorRecord): void {
  for (const [field, value] of [
    ["attrs", descriptor.attrs],
    ["base", descriptor.base],
    ["limit", descriptor.limit],
    ["reserved", descriptor.reserved]
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > maxU32) {
      throw new RangeError(`descriptor ${field} must be a u32: ${value}`);
    }
  }

  const { attrs, base, limit, reserved } = descriptor;

  if ((attrs & ~DESCRIPTOR_DEFINED_ATTR_MASK) !== 0) {
    throw new RangeError(`descriptor attrs contain reserved bits: 0x${attrs.toString(16)}`);
  }
  if (reserved !== 0) {
    throw new RangeError(`descriptor reserved word must be zero: 0x${reserved.toString(16)}`);
  }

  const defined = (attrs & DESCRIPTOR_ATTR.DEFINED) !== 0;

  if (!defined) {
    if (attrs !== 0 || base !== 0 || limit !== 0) {
      throw new RangeError("an undefined descriptor must be all zero");
    }
    return;
  }

  if ((attrs & DESCRIPTOR_TARGET_ATTR_MASK) === 0) {
    throw new RangeError("a defined descriptor must authorize at least one load target");
  }
  if ((attrs & DESCRIPTOR_ATTR.LOAD_DATA) !== 0 && (attrs & DESCRIPTOR_ATTR.READ) === 0) {
    throw new RangeError("a data-loadable descriptor must be readable");
  }
  if (
    (attrs & DESCRIPTOR_ATTR.LOAD_STACK) !== 0 &&
    (attrs & (DESCRIPTOR_ATTR.READ | DESCRIPTOR_ATTR.WRITE)) !==
      (DESCRIPTOR_ATTR.READ | DESCRIPTOR_ATTR.WRITE)
  ) {
    throw new RangeError("a stack-loadable descriptor must be readable and writable");
  }
  if ((attrs & DESCRIPTOR_ATTR.LOAD_CODE) !== 0 && (attrs & DESCRIPTOR_ATTR.EXECUTE) === 0) {
    throw new RangeError("a code-loadable descriptor must be executable");
  }
  if (
    (attrs & DESCRIPTOR_ATTR.LOAD_CODE) !== 0 &&
    (attrs & (DESCRIPTOR_ATTR.WRITE | DESCRIPTOR_ATTR.LOAD_STACK)) !== 0
  ) {
    throw new RangeError("a code-loadable descriptor cannot be writable or stack-loadable");
  }
  if ((attrs & DESCRIPTOR_ATTR.WRITE) !== 0 && (attrs & DESCRIPTOR_ATTR.READ) === 0) {
    throw new RangeError("a writable descriptor must be readable");
  }
  if ((attrs & DESCRIPTOR_ATTR.EXECUTE) !== 0 && (attrs & DESCRIPTOR_ATTR.LOAD_CODE) === 0) {
    throw new RangeError("descriptor execute access requires code-load policy");
  }
  if (
    (attrs & DESCRIPTOR_ATTR.WRITE) !== 0 &&
    (attrs & (DESCRIPTOR_ATTR.LOAD_DATA | DESCRIPTOR_ATTR.LOAD_STACK)) === 0
  ) {
    throw new RangeError("descriptor write access requires data or stack load policy");
  }
  if (base > maxU32 - limit) {
    throw new RangeError(`descriptor linear image wraps: base 0x${base.toString(16)}, limit 0x${limit.toString(16)}`);
  }
}
