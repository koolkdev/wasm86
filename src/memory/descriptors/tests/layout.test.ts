import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  descriptorAccessAttrMask,
  descriptorAttr,
  descriptorDefinedAttrMask,
  descriptorFields,
  descriptorKey,
  descriptorLayout,
  descriptorRecordOffset,
  descriptorTableByteLength,
  descriptorTargetAttrMask,
  validateDescriptor,
  type DescriptorRecord
} from "#memory/descriptors/layout.js";

const readableDataAttrs =
  descriptorAttr.DEFINED |
  descriptorAttr.PRESENT |
  descriptorAttr.LOAD_DATA |
  descriptorAttr.READ;

function descriptor(overrides: Partial<DescriptorRecord> = {}): DescriptorRecord {
  return {
    attrs: readableDataAttrs,
    base: 0,
    limit: 0xffff_ffff,
    reserved: 0,
    ...overrides
  };
}

test("descriptor table size and record offsets are table-relative", () => {
  strictEqual(descriptorLayout.byteLength % descriptorLayout.alignment, 0);
  strictEqual(
    descriptorTableByteLength,
    descriptorLayout.count * descriptorLayout.byteLength
  );
  strictEqual(descriptorRecordOffset(0), 0);
  strictEqual(
    descriptorRecordOffset(0xffff) + descriptorLayout.byteLength,
    descriptorTableByteLength
  );
});

test("descriptor record fields are aligned, nonoverlapping u32 words", () => {
  const offsets = Object.values(descriptorFields).sort((left, right) => left - right);

  strictEqual(offsets.length, 4);
  for (const [index, offset] of offsets.entries()) {
    strictEqual(offset % 4, 0);
    strictEqual(offset + 4 <= descriptorLayout.byteLength, true);
    if (index > 0) {
      strictEqual(offsets[index - 1]! + 4 <= offset, true);
    }
  }
});

test("descriptor attrs preserve target and access policy meaning", () => {
  deepStrictEqual(descriptorAttr, {
    DEFINED: 1 << 0,
    PRESENT: 1 << 1,
    LOAD_DATA: 1 << 2,
    LOAD_STACK: 1 << 3,
    LOAD_CODE: 1 << 4,
    READ: 1 << 5,
    WRITE: 1 << 6,
    EXECUTE: 1 << 7
  });
  strictEqual(
    descriptorTargetAttrMask,
    descriptorAttr.LOAD_DATA |
      descriptorAttr.LOAD_STACK |
      descriptorAttr.LOAD_CODE
  );
  strictEqual(
    descriptorAccessAttrMask,
    descriptorAttr.READ | descriptorAttr.WRITE | descriptorAttr.EXECUTE
  );
  strictEqual(
    descriptorDefinedAttrMask,
    descriptorAttr.DEFINED |
      descriptorAttr.PRESENT |
      descriptorTargetAttrMask |
      descriptorAccessAttrMask
  );
});

test("descriptor keys discard RPL while retaining TI", () => {
  strictEqual(descriptorKey(0x0008), 2);
  strictEqual(descriptorKey(0x000b), 2);
  strictEqual(descriptorKey(0x000c), 3);
  strictEqual(descriptorKey(0x000f), 3);
  strictEqual(descriptorKey(0xffff), descriptorLayout.count - 1);
});

test("descriptor validation owns field and policy checks", () => {
  strictEqual(validateDescriptor({ attrs: 0, base: 0, limit: 0, reserved: 0 }), true);
  strictEqual(validateDescriptor(descriptor()), true);
  strictEqual(
    validateDescriptor(descriptor({ attrs: readableDataAttrs & ~descriptorAttr.PRESENT })),
    true
  );

  const invalidRecords: readonly DescriptorRecord[] = [
    descriptor({ attrs: readableDataAttrs | (1 << 8) }),
    descriptor({ reserved: 1 }),
    descriptor({ attrs: 0, base: 1, limit: 0 }),
    descriptor({ attrs: descriptorAttr.PRESENT }),
    descriptor({ attrs: descriptorAttr.DEFINED }),
    descriptor({ attrs: descriptorAttr.DEFINED | descriptorAttr.LOAD_DATA }),
    descriptor({
      attrs: descriptorAttr.DEFINED | descriptorAttr.LOAD_STACK | descriptorAttr.READ
    }),
    descriptor({ attrs: descriptorAttr.DEFINED | descriptorAttr.LOAD_CODE }),
    descriptor({
      attrs: descriptorAttr.DEFINED |
        descriptorAttr.LOAD_CODE |
        descriptorAttr.EXECUTE |
        descriptorAttr.WRITE |
        descriptorAttr.READ
    }),
    descriptor({
      attrs: descriptorAttr.DEFINED |
        descriptorAttr.LOAD_CODE |
        descriptorAttr.LOAD_STACK |
        descriptorAttr.EXECUTE |
        descriptorAttr.READ |
        descriptorAttr.WRITE
    }),
    descriptor({
      attrs: descriptorAttr.DEFINED | descriptorAttr.LOAD_DATA | descriptorAttr.WRITE
    }),
    descriptor({
      attrs: descriptorAttr.DEFINED |
        descriptorAttr.LOAD_DATA |
        descriptorAttr.READ |
        descriptorAttr.EXECUTE
    }),
    descriptor({
      attrs: descriptorAttr.DEFINED | descriptorAttr.READ | descriptorAttr.WRITE
    }),
    descriptor({ base: 1, limit: 0xffff_ffff })
  ];

  for (const invalid of invalidRecords) {
    strictEqual(validateDescriptor(invalid), false);
  }

  for (const invalid of [-1, 0x1_0000_0000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    strictEqual(validateDescriptor(descriptor({ base: invalid })), false);
  }
});
