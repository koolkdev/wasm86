import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import {
  DESCRIPTOR_ACCESS_ATTR_MASK,
  DESCRIPTOR_ATTR,
  DESCRIPTOR_DEFINED_ATTR_MASK,
  DESCRIPTOR_RECORD_BYTE_LENGTH,
  DESCRIPTOR_RECORD_COUNT,
  DESCRIPTOR_RECORD_LAYOUT,
  DESCRIPTOR_TABLE_BASE,
  DESCRIPTOR_TABLE_BYTE_LENGTH,
  DESCRIPTOR_TARGET_ATTR_MASK,
  MACHINE_FIXED_END,
  MACHINE_FIXED_PAGE_COUNT,
  MACHINE_PAGE_TABLE_BASE,
  MACHINE_PAGE_TABLE_BYTE_LENGTH,
  MACHINE_PAGE_TABLE_ENTRY_BYTE_LENGTH,
  MACHINE_PAGE_TABLE_ENTRY_COUNT,
  descriptorKey,
  descriptorRecordOffset
} from "#wasm/machine-state-layout.js";

test("machine memory has the third ABI index without changing existing indices", () => {
  strictEqual(wasmImport.machineMemoryName, "machine");
  deepStrictEqual(wasmMemoryIndex, { cpuState: 0, guest: 1, machine: 2 });
});

test("machine fixed layout reserves the complete page and descriptor tables", () => {
  strictEqual(MACHINE_PAGE_TABLE_BASE, 0);
  strictEqual(MACHINE_PAGE_TABLE_ENTRY_BYTE_LENGTH, 4);
  strictEqual(MACHINE_PAGE_TABLE_ENTRY_COUNT, 0x10_0000);
  strictEqual(MACHINE_PAGE_TABLE_BYTE_LENGTH, 0x40_0000);
  strictEqual(DESCRIPTOR_TABLE_BASE, 0x40_0000);
  strictEqual(DESCRIPTOR_RECORD_BYTE_LENGTH, 16);
  strictEqual(DESCRIPTOR_RECORD_COUNT, 0x4000);
  strictEqual(DESCRIPTOR_TABLE_BYTE_LENGTH, 0x4_0000);
  strictEqual(MACHINE_FIXED_END, 0x44_0000);
  strictEqual(MACHINE_FIXED_PAGE_COUNT, 68);
  strictEqual(
    descriptorRecordOffset(0xffff) + DESCRIPTOR_RECORD_BYTE_LENGTH,
    MACHINE_FIXED_END
  );
});

test("descriptor keys discard RPL while retaining TI", () => {
  strictEqual(descriptorKey(0x0008), 2);
  strictEqual(descriptorKey(0x000b), 2);
  strictEqual(descriptorKey(0x000c), 3);
  strictEqual(descriptorKey(0xffff), 0x3fff);
  strictEqual(descriptorRecordOffset(0x0008), DESCRIPTOR_TABLE_BASE + 0x20);
  strictEqual(descriptorRecordOffset(0x000c), DESCRIPTOR_TABLE_BASE + 0x30);
});

test("descriptor record fields and defined attrs have a stable ABI", () => {
  deepStrictEqual(DESCRIPTOR_RECORD_LAYOUT, {
    attrs: 0,
    base: 4,
    limit: 8,
    reserved: 12
  });
  deepStrictEqual(DESCRIPTOR_ATTR, {
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
    DESCRIPTOR_TARGET_ATTR_MASK,
    DESCRIPTOR_ATTR.LOAD_DATA | DESCRIPTOR_ATTR.LOAD_STACK | DESCRIPTOR_ATTR.LOAD_CODE
  );
  strictEqual(
    DESCRIPTOR_ACCESS_ATTR_MASK,
    DESCRIPTOR_ATTR.READ | DESCRIPTOR_ATTR.WRITE | DESCRIPTOR_ATTR.EXECUTE
  );
  strictEqual(DESCRIPTOR_DEFINED_ATTR_MASK, 0xff);
});
