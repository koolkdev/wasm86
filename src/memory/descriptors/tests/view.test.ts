import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  descriptorAttr,
  descriptorFields,
  descriptorLayout,
  descriptorRecordOffset,
  descriptorTableByteLength,
  type DescriptorRecord
} from "#memory/descriptors/layout.js";
import { DescriptorTableView } from "#memory/descriptors/view.js";

const wasmPageByteLength = 0x1_0000;
const minimumPageCount = Math.ceil(descriptorTableByteLength / wasmPageByteLength);
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

function createDescriptorTableView(pageCount = minimumPageCount): DescriptorTableView {
  return new DescriptorTableView(new WebAssembly.Memory({ initial: pageCount }));
}

test("descriptor view rejects memory shorter than its complete layout", () => {
  strictEqual(minimumPageCount, 4);
  throws(
    () => createDescriptorTableView(minimumPageCount - 1),
    new RegExp(`descriptor memory is too small: .* < ${descriptorTableByteLength}`)
  );
  strictEqual(
    createDescriptorTableView(minimumPageCount + 1).memory.buffer.byteLength,
    (minimumPageCount + 1) * wasmPageByteLength
  );
});

test("descriptor view rejects shared memory until publication is atomic", () => {
  for (const pageCount of [minimumPageCount - 1, minimumPageCount]) {
    const memory = new WebAssembly.Memory({
      initial: pageCount,
      maximum: pageCount,
      shared: true
    });

    throws(
      () => new DescriptorTableView(memory),
      /shared descriptor memory requires an atomic publication protocol/
    );
  }
});

test("descriptor records keep GDT and LDT selectors distinct while aliasing RPL", () => {
  const view = createDescriptorTableView();
  const gdt = descriptor({ base: 0x1000, limit: 0x1fff });
  const ldt = descriptor({ base: 0x4000, limit: 0x2fff });

  strictEqual(view.readDescriptor(0x0008), undefined);

  view.writeDescriptor(0x0008, gdt);
  view.writeDescriptor(0x000c, ldt);

  deepStrictEqual(view.readDescriptor(0x0008), gdt);
  deepStrictEqual(view.readDescriptor(0x000b), gdt);
  deepStrictEqual(view.readDescriptor(0x000c), ldt);
  deepStrictEqual(view.readDescriptor(0x000f), ldt);

  view.clearDescriptor(0x000a);

  strictEqual(view.readDescriptor(0x0008), undefined);
  deepStrictEqual(view.readDescriptor(0x000c), ldt);
});

test("defined non-present records remain distinct from undefined records", () => {
  const view = createDescriptorTableView();
  const nonPresent = descriptor({ attrs: readableDataAttrs & ~descriptorAttr.PRESENT });

  view.writeDescriptor(0x20, nonPresent);

  strictEqual(view.readDescriptor(0x18), undefined);
  deepStrictEqual(view.readDescriptor(0x20), nonPresent);
  strictEqual((view.readDescriptor(0x20)?.attrs ?? 0) & descriptorAttr.PRESENT, 0);
});

test("descriptor limits include one-byte and complete-u32 offset ranges", () => {
  const view = createDescriptorTableView();
  const oneByte = descriptor({ base: 0xffff_ffff, limit: 0 });
  const full = descriptor({ base: 0, limit: 0xffff_ffff });

  view.writeDescriptor(0x28, oneByte);
  view.writeDescriptor(0x30, full);

  deepStrictEqual(view.readDescriptor(0x28), oneByte);
  deepStrictEqual(view.readDescriptor(0x30), full);
});

test("descriptor mutation accepts compatible target policies", () => {
  const view = createDescriptorTableView();
  const records = [
    descriptor({
      attrs: descriptorAttr.DEFINED |
        descriptorAttr.LOAD_DATA |
        descriptorAttr.LOAD_STACK |
        descriptorAttr.READ |
        descriptorAttr.WRITE,
      limit: 0
    }),
    descriptor({
      attrs: descriptorAttr.DEFINED |
        descriptorAttr.LOAD_CODE |
        descriptorAttr.EXECUTE,
      limit: 0
    }),
    descriptor({
      attrs: descriptorAttr.DEFINED |
        descriptorAttr.LOAD_CODE |
        descriptorAttr.LOAD_DATA |
        descriptorAttr.READ |
        descriptorAttr.EXECUTE,
      limit: 0
    })
  ];

  for (const [index, record] of records.entries()) {
    const selector = 0x40 + index * 8;

    view.writeDescriptor(selector, record);
    deepStrictEqual(view.readDescriptor(selector), record);
  }
});

test("descriptor validation completes before a write changes the prior record", () => {
  const view = createDescriptorTableView();
  const selector = 0x58;
  const prior = descriptor({ base: 0x1000, limit: 0x1000 });

  view.writeDescriptor(selector, prior);

  throws(
    () => view.writeDescriptor(selector, descriptor({ reserved: 1 })),
    new RangeError("invalid descriptor")
  );
  deepStrictEqual(view.readDescriptor(selector), prior);
});

test("descriptor mutation rejects non-u16 selectors", () => {
  const view = createDescriptorTableView();

  for (const selector of [-1, 0x1_0000, 1.5, Number.NaN]) {
    throws(
      () => view.writeDescriptor(selector, descriptor()),
      /descriptor selector must be a u16/
    );
    throws(
      () => view.clearDescriptor(selector),
      /descriptor selector must be a u16/
    );
  }
});

test("descriptor codec uses owner fields and little-endian words", () => {
  const view = createDescriptorTableView();
  const record = descriptor({ base: 0x1234_5678, limit: 0x1020_3040 });
  const selector = 0x68;

  view.writeDescriptor(selector, record);

  const offset = descriptorRecordOffset(selector);
  const bytes = new Uint8Array(view.memory.buffer);

  deepStrictEqual(
    bytes.slice(offset + descriptorFields.base, offset + descriptorFields.base + 4),
    Uint8Array.of(0x78, 0x56, 0x34, 0x12)
  );
  deepStrictEqual(
    bytes.slice(offset + descriptorFields.limit, offset + descriptorFields.limit + 4),
    Uint8Array.of(0x40, 0x30, 0x20, 0x10)
  );
});

test("descriptor access covers the first and final records", () => {
  const view = createDescriptorTableView();
  const first = descriptor({ base: 1, limit: 0 });
  const last = descriptor({ base: 2, limit: 0 });

  view.writeDescriptor(0, first);
  view.writeDescriptor(0xffff, last);

  deepStrictEqual(view.readDescriptor(0), first);
  deepStrictEqual(view.readDescriptor(0xffff), last);
  strictEqual(
    descriptorRecordOffset(0xffff) + descriptorLayout.byteLength,
    descriptorTableByteLength
  );
});

test("descriptor view preserves supplied bytes and validates raw records", () => {
  const memory = new WebAssembly.Memory({ initial: minimumPageCount + 1 });
  const bytes = new Uint8Array(memory.buffer);

  bytes[0x1234] = 0xa5;
  bytes[descriptorTableByteLength] = 0x5a;

  const view = new DescriptorTableView(memory);

  strictEqual(bytes[0x1234], 0xa5);
  strictEqual(bytes[descriptorTableByteLength], 0x5a);

  const offset = descriptorRecordOffset(0x70);
  const raw = new DataView(memory.buffer);

  raw.setUint32(offset + descriptorFields.attrs, readableDataAttrs, true);
  raw.setUint32(offset + descriptorFields.base, 0, true);
  raw.setUint32(offset + descriptorFields.limit, 0, true);
  raw.setUint32(offset + descriptorFields.reserved, 1, true);

  throws(
    () => view.readDescriptor(0x70),
    { name: "Error", message: "stored descriptor is invalid" }
  );
});

test("descriptor view refreshes its DataView after memory growth", () => {
  const view = createDescriptorTableView();
  const record = descriptor({ base: 0x2000, limit: 0x3fff });

  view.memory.grow(1);
  view.writeDescriptor(0x78, record);

  deepStrictEqual(view.readDescriptor(0x78), record);
});
