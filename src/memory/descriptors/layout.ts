import { assert } from "#common/assert.js";

const maxU32 = 0xffff_ffff;

export type DescriptorRecord = Readonly<{
  attrs: number;
  base: number;
  limit: number;
  reserved: number;
}>;

export const descriptorFields = {
  attrs: 0x00,
  base: 0x04,
  limit: 0x08,
  reserved: 0x0c
} as const;

export const descriptorLayout = {
  byteLength: 0x10,
  alignment: 4,
  fields: descriptorFields
} as const;

export const descriptorAttr = {
  DEFINED: 1 << 0,
  PRESENT: 1 << 1,
  LOAD_DATA: 1 << 2,
  LOAD_STACK: 1 << 3,
  LOAD_CODE: 1 << 4,
  READ: 1 << 5,
  WRITE: 1 << 6,
  EXECUTE: 1 << 7
} as const;

export const descriptorTargetAttrMask =
  descriptorAttr.LOAD_DATA |
  descriptorAttr.LOAD_STACK |
  descriptorAttr.LOAD_CODE;
export const descriptorAccessAttrMask =
  descriptorAttr.READ |
  descriptorAttr.WRITE |
  descriptorAttr.EXECUTE;
export const descriptorDefinedAttrMask =
  descriptorAttr.DEFINED |
  descriptorAttr.PRESENT |
  descriptorTargetAttrMask |
  descriptorAccessAttrMask;

assert(
  descriptorLayout.byteLength % descriptorLayout.alignment === 0,
  "descriptor record length must satisfy record alignment"
);

export function descriptorKey(selector: number): number {
  return (selector & 0xffff) >>> 2;
}

export function validateDescriptor(descriptor: DescriptorRecord): boolean {
  for (const value of [
    descriptor.attrs,
    descriptor.base,
    descriptor.limit,
    descriptor.reserved
  ]) {
    if (!Number.isInteger(value) || value < 0 || value > maxU32) {
      // Every stored field must be a u32.
      return false;
    }
  }

  const { attrs, base, limit, reserved } = descriptor;

  if ((attrs & ~descriptorDefinedAttrMask) !== 0) {
    // Attribute bits outside the defined policy are reserved.
    return false;
  }
  if (reserved !== 0) {
    // The reserved word must remain zero.
    return false;
  }

  const defined = (attrs & descriptorAttr.DEFINED) !== 0;

  if (!defined) {
    // An undefined descriptor must be all zero.
    return attrs === 0 && base === 0 && limit === 0;
  }

  if ((attrs & descriptorTargetAttrMask) === 0) {
    // A defined descriptor must authorize at least one load target.
    return false;
  }
  if ((attrs & descriptorAttr.LOAD_DATA) !== 0 && (attrs & descriptorAttr.READ) === 0) {
    // A data-loadable descriptor must be readable.
    return false;
  }
  if (
    (attrs & descriptorAttr.LOAD_STACK) !== 0 &&
    (attrs & (descriptorAttr.READ | descriptorAttr.WRITE)) !==
      (descriptorAttr.READ | descriptorAttr.WRITE)
  ) {
    // A stack-loadable descriptor must be readable and writable.
    return false;
  }
  if ((attrs & descriptorAttr.LOAD_CODE) !== 0 && (attrs & descriptorAttr.EXECUTE) === 0) {
    // A code-loadable descriptor must be executable.
    return false;
  }
  if (
    (attrs & descriptorAttr.LOAD_CODE) !== 0 &&
    (attrs & (descriptorAttr.WRITE | descriptorAttr.LOAD_STACK)) !== 0
  ) {
    // A code-loadable descriptor cannot be writable or stack-loadable.
    return false;
  }
  if ((attrs & descriptorAttr.WRITE) !== 0 && (attrs & descriptorAttr.READ) === 0) {
    // A writable descriptor must be readable.
    return false;
  }
  if ((attrs & descriptorAttr.EXECUTE) !== 0 && (attrs & descriptorAttr.LOAD_CODE) === 0) {
    // Execute access requires code-load policy.
    return false;
  }
  if (
    (attrs & descriptorAttr.WRITE) !== 0 &&
    (attrs & (descriptorAttr.LOAD_DATA | descriptorAttr.LOAD_STACK)) === 0
  ) {
    // Write access requires data- or stack-load policy.
    return false;
  }
  if (base > maxU32 - limit) {
    // The inclusive linear image must not wrap the u32 address space.
    return false;
  }

  return true;
}
