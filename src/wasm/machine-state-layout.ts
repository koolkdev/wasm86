import { assert } from "#common/assert.js";
import { wasmPageByteLength } from "#wasm/abi.js";

export const MACHINE_PAGE_TABLE_BASE = 0;
export const MACHINE_PAGE_TABLE_ENTRY_BYTE_LENGTH = 4;
export const MACHINE_PAGE_TABLE_ENTRY_COUNT = 0x10_0000;
export const MACHINE_PAGE_TABLE_BYTE_LENGTH =
  MACHINE_PAGE_TABLE_ENTRY_COUNT * MACHINE_PAGE_TABLE_ENTRY_BYTE_LENGTH;

export const DESCRIPTOR_TABLE_BASE = MACHINE_PAGE_TABLE_BASE + MACHINE_PAGE_TABLE_BYTE_LENGTH;
export const DESCRIPTOR_RECORD_BYTE_LENGTH = 0x10;
export const DESCRIPTOR_RECORD_COUNT = 0x4000;
export const DESCRIPTOR_TABLE_BYTE_LENGTH = DESCRIPTOR_RECORD_COUNT * DESCRIPTOR_RECORD_BYTE_LENGTH;

export const MACHINE_FIXED_END = DESCRIPTOR_TABLE_BASE + DESCRIPTOR_TABLE_BYTE_LENGTH;
export const MACHINE_FIXED_PAGE_COUNT = MACHINE_FIXED_END / wasmPageByteLength;

export const DESCRIPTOR_RECORD_LAYOUT = {
  attrs: 0x00,
  base: 0x04,
  limit: 0x08,
  reserved: 0x0c
} as const;

export const DESCRIPTOR_ATTR = {
  DEFINED: 1 << 0,
  PRESENT: 1 << 1,
  LOAD_DATA: 1 << 2,
  LOAD_STACK: 1 << 3,
  LOAD_CODE: 1 << 4,
  READ: 1 << 5,
  WRITE: 1 << 6,
  EXECUTE: 1 << 7
} as const;

export const DESCRIPTOR_TARGET_ATTR_MASK =
  DESCRIPTOR_ATTR.LOAD_DATA |
  DESCRIPTOR_ATTR.LOAD_STACK |
  DESCRIPTOR_ATTR.LOAD_CODE;
export const DESCRIPTOR_ACCESS_ATTR_MASK =
  DESCRIPTOR_ATTR.READ |
  DESCRIPTOR_ATTR.WRITE |
  DESCRIPTOR_ATTR.EXECUTE;
export const DESCRIPTOR_DEFINED_ATTR_MASK =
  DESCRIPTOR_ATTR.DEFINED |
  DESCRIPTOR_ATTR.PRESENT |
  DESCRIPTOR_TARGET_ATTR_MASK |
  DESCRIPTOR_ACCESS_ATTR_MASK;

assert(MACHINE_PAGE_TABLE_BASE === 0, "machine page table must start at offset zero");
assert(MACHINE_PAGE_TABLE_BYTE_LENGTH === 0x40_0000, "machine page table reservation must occupy 4 MiB");
assert(DESCRIPTOR_TABLE_BASE === 0x40_0000, "descriptor table must follow the page table reservation");
assert(DESCRIPTOR_TABLE_BYTE_LENGTH === 0x4_0000, "descriptor table reservation must occupy 256 KiB");
assert(MACHINE_FIXED_END === 0x44_0000, "unexpected machine fixed-layout end");
assert(Number.isInteger(MACHINE_FIXED_PAGE_COUNT), "machine fixed layout must end on a Wasm page boundary");

export function descriptorKey(selector: number): number {
  return (selector & 0xffff) >>> 2;
}

export function descriptorRecordOffset(selector: number): number {
  return DESCRIPTOR_TABLE_BASE + descriptorKey(selector) * DESCRIPTOR_RECORD_BYTE_LENGTH;
}
