import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { MachineState, type DescriptorRecord } from "#wasm/host/machine-state.js";
import {
  DESCRIPTOR_ATTR,
  DESCRIPTOR_RECORD_LAYOUT,
  MACHINE_FIXED_END,
  MACHINE_FIXED_PAGE_COUNT,
  descriptorRecordOffset
} from "#wasm/machine-state-layout.js";

const readableDataAttrs =
  DESCRIPTOR_ATTR.DEFINED |
  DESCRIPTOR_ATTR.PRESENT |
  DESCRIPTOR_ATTR.LOAD_DATA |
  DESCRIPTOR_ATTR.READ;

function descriptor(overrides: Partial<DescriptorRecord> = {}): DescriptorRecord {
  return {
    attrs: readableDataAttrs,
    base: 0,
    limit: 0xffff_ffff,
    reserved: 0,
    ...overrides
  };
}

function createMachineState(pageCount = MACHINE_FIXED_PAGE_COUNT): MachineState {
  return new MachineState(new WebAssembly.Memory({ initial: pageCount }));
}

test("machine state rejects memory shorter than the complete fixed layout", () => {
  throws(
    () => createMachineState(MACHINE_FIXED_PAGE_COUNT - 1),
    new RegExp(`machine memory is too small: .* < ${MACHINE_FIXED_END}`)
  );
  strictEqual(createMachineState(MACHINE_FIXED_PAGE_COUNT + 1).memory.buffer.byteLength, 69 * 0x1_0000);
});

test("machine state rejects shared memory until descriptor publication is atomic", () => {
  const memory = new WebAssembly.Memory({
    initial: MACHINE_FIXED_PAGE_COUNT,
    maximum: MACHINE_FIXED_PAGE_COUNT,
    shared: true
  });

  throws(
    () => new MachineState(memory),
    /shared machine memory requires an atomic publication protocol/
  );
});

test("descriptor records keep GDT and LDT selectors distinct while aliasing RPL", () => {
  const state = createMachineState();
  const gdt = descriptor({ base: 0x1000, limit: 0x1fff });
  const ldt = descriptor({ base: 0x4000, limit: 0x2fff });

  strictEqual(state.readDescriptor(0x0008), undefined);

  state.writeDescriptor(0x0008, gdt);
  state.writeDescriptor(0x000c, ldt);

  deepStrictEqual(state.readDescriptor(0x0008), gdt);
  deepStrictEqual(state.readDescriptor(0x000b), gdt);
  deepStrictEqual(state.readDescriptor(0x000c), ldt);
  deepStrictEqual(state.readDescriptor(0x000f), ldt);

  state.clearDescriptor(0x000a);

  strictEqual(state.readDescriptor(0x0008), undefined);
  deepStrictEqual(state.readDescriptor(0x000c), ldt);
});

test("defined non-present records remain distinct from undefined records", () => {
  const state = createMachineState();
  const nonPresent = descriptor({ attrs: readableDataAttrs & ~DESCRIPTOR_ATTR.PRESENT });

  state.writeDescriptor(0x20, nonPresent);

  strictEqual(state.readDescriptor(0x18), undefined);
  deepStrictEqual(state.readDescriptor(0x20), nonPresent);
  strictEqual((state.readDescriptor(0x20)?.attrs ?? 0) & DESCRIPTOR_ATTR.PRESENT, 0);
});

test("descriptor limits include both one-byte and complete-u32 offset ranges", () => {
  const state = createMachineState();
  const oneByte = descriptor({ base: 0xffff_ffff, limit: 0 });
  const full = descriptor({ base: 0, limit: 0xffff_ffff });

  state.writeDescriptor(0x28, oneByte);
  state.writeDescriptor(0x30, full);

  deepStrictEqual(state.readDescriptor(0x28), oneByte);
  deepStrictEqual(state.readDescriptor(0x30), full);
});

test("descriptor mutation accepts compatible target policies", () => {
  const state = createMachineState();
  const records = [
    descriptor({
      attrs: DESCRIPTOR_ATTR.DEFINED |
        DESCRIPTOR_ATTR.LOAD_DATA |
        DESCRIPTOR_ATTR.LOAD_STACK |
        DESCRIPTOR_ATTR.READ |
        DESCRIPTOR_ATTR.WRITE,
      limit: 0
    }),
    descriptor({
      attrs: DESCRIPTOR_ATTR.DEFINED |
        DESCRIPTOR_ATTR.LOAD_CODE |
        DESCRIPTOR_ATTR.EXECUTE,
      limit: 0
    }),
    descriptor({
      attrs: DESCRIPTOR_ATTR.DEFINED |
        DESCRIPTOR_ATTR.LOAD_CODE |
        DESCRIPTOR_ATTR.LOAD_DATA |
        DESCRIPTOR_ATTR.READ |
        DESCRIPTOR_ATTR.EXECUTE,
      limit: 0
    })
  ];

  for (const [index, record] of records.entries()) {
    const selector = 0x40 + index * 8;

    state.writeDescriptor(selector, record);
    deepStrictEqual(state.readDescriptor(selector), record);
  }
});

test("invalid descriptor writes are rejected before the prior record is changed", () => {
  const state = createMachineState();
  const selector = 0x58;
  const prior = descriptor({ base: 0x1000, limit: 0x1000 });
  const invalidRecords: readonly DescriptorRecord[] = [
    descriptor({ attrs: readableDataAttrs | (1 << 8) }),
    descriptor({ reserved: 1 }),
    descriptor({ attrs: 0, base: 1, limit: 0 }),
    descriptor({ attrs: DESCRIPTOR_ATTR.PRESENT }),
    descriptor({ attrs: DESCRIPTOR_ATTR.DEFINED }),
    descriptor({ attrs: DESCRIPTOR_ATTR.DEFINED | DESCRIPTOR_ATTR.LOAD_DATA }),
    descriptor({
      attrs: DESCRIPTOR_ATTR.DEFINED | DESCRIPTOR_ATTR.LOAD_STACK | DESCRIPTOR_ATTR.READ
    }),
    descriptor({ attrs: DESCRIPTOR_ATTR.DEFINED | DESCRIPTOR_ATTR.LOAD_CODE }),
    descriptor({
      attrs: DESCRIPTOR_ATTR.DEFINED |
        DESCRIPTOR_ATTR.LOAD_CODE |
        DESCRIPTOR_ATTR.EXECUTE |
        DESCRIPTOR_ATTR.WRITE |
        DESCRIPTOR_ATTR.READ
    }),
    descriptor({
      attrs: DESCRIPTOR_ATTR.DEFINED |
        DESCRIPTOR_ATTR.LOAD_CODE |
        DESCRIPTOR_ATTR.LOAD_STACK |
        DESCRIPTOR_ATTR.EXECUTE |
        DESCRIPTOR_ATTR.READ |
        DESCRIPTOR_ATTR.WRITE
    }),
    descriptor({
      attrs: DESCRIPTOR_ATTR.DEFINED | DESCRIPTOR_ATTR.LOAD_DATA | DESCRIPTOR_ATTR.WRITE
    }),
    descriptor({
      attrs: DESCRIPTOR_ATTR.DEFINED | DESCRIPTOR_ATTR.LOAD_DATA | DESCRIPTOR_ATTR.READ | DESCRIPTOR_ATTR.EXECUTE
    }),
    descriptor({
      attrs: DESCRIPTOR_ATTR.DEFINED | DESCRIPTOR_ATTR.READ | DESCRIPTOR_ATTR.WRITE
    }),
    descriptor({ base: 1, limit: 0xffff_ffff })
  ];

  state.writeDescriptor(selector, prior);

  for (const invalid of invalidRecords) {
    throws(() => state.writeDescriptor(selector, invalid));
    deepStrictEqual(state.readDescriptor(selector), prior);
  }
});

test("descriptor mutation rejects non-u32 fields and non-u16 selectors", () => {
  const state = createMachineState();

  for (const invalid of [-1, 0x1_0000_0000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    throws(() => state.writeDescriptor(0x60, descriptor({ base: invalid })), /descriptor base must be a u32/);
  }

  for (const selector of [-1, 0x1_0000, 1.5, Number.NaN]) {
    throws(() => state.writeDescriptor(selector, descriptor()), /descriptor selector must be a u16/);
    throws(() => state.clearDescriptor(selector), /descriptor selector must be a u16/);
  }
});

test("machine accessors preserve supplied bytes and validate raw descriptor records", () => {
  const memory = new WebAssembly.Memory({ initial: MACHINE_FIXED_PAGE_COUNT + 1 });
  const bytes = new Uint8Array(memory.buffer);

  bytes[0x1234] = 0xa5;
  bytes[MACHINE_FIXED_END] = 0x5a;

  const state = new MachineState(memory);

  strictEqual(bytes[0x1234], 0xa5);
  strictEqual(bytes[MACHINE_FIXED_END], 0x5a);

  const offset = descriptorRecordOffset(0x68);
  const view = new DataView(memory.buffer);

  view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.attrs, readableDataAttrs, true);
  view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.base, 0, true);
  view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.limit, 0, true);
  view.setUint32(offset + DESCRIPTOR_RECORD_LAYOUT.reserved, 1, true);

  throws(() => state.readDescriptor(0x68), /descriptor reserved word must be zero/);
});
