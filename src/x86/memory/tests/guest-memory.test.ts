import { deepStrictEqual, doesNotThrow, strictEqual } from "node:assert";
import { test } from "node:test";

import { ArrayBufferGuestMemory, type MemoryReadResult } from "#x86/memory/guest-memory.js";
import { assertGuestWriteOk, readGuestBytes, readGuestValue } from "./helpers.js";

test("u32_little_endian_roundtrip", () => {
  const memory = new ArrayBufferGuestMemory(8);

  assertGuestWriteOk(memory.writeU32(0, 0x1234_5678));

  deepStrictEqual(readGuestBytes(memory, 0, 4), [0x78, 0x56, 0x34, 0x12]);
  strictEqual(readGuestValue(memory.readU32(0)), 0x1234_5678);
});

test("u16_little_endian_roundtrip", () => {
  const memory = new ArrayBufferGuestMemory(4);

  assertGuestWriteOk(memory.writeU16(0, 0x1234));

  deepStrictEqual(readGuestBytes(memory, 0, 2), [0x34, 0x12]);
  strictEqual(readGuestValue(memory.readU16(0)), 0x1234);
});

test("u8_roundtrip", () => {
  const memory = new ArrayBufferGuestMemory(1);

  assertGuestWriteOk(memory.writeU8(0, 0x1234));

  strictEqual(readGuestValue(memory.readU8(0)), 0x34);
});

test("read_oob_reports_fault", () => {
  const memory = new ArrayBufferGuestMemory(4);
  let result: MemoryReadResult | undefined;

  doesNotThrow(() => {
    result = memory.readU8(4);
  });

  deepStrictEqual(result, {
    ok: false,
    fault: { faultAddress: 4, faultSize: 1, guestAccess: "read" }
  });
});

test("write_oob_does_not_partially_mutate", () => {
  const memory = new ArrayBufferGuestMemory(4);

  for (let address = 0; address < memory.byteLength; address += 1) {
    assertGuestWriteOk(memory.writeU8(address, 0xaa));
  }

  const before = readGuestBytes(memory, 0, memory.byteLength);
  const result = memory.writeU32(2, 0x1234_5678);

  deepStrictEqual(result, {
    ok: false,
    fault: { faultAddress: 2, faultSize: 4, guestAccess: "write" }
  });
  deepStrictEqual(readGuestBytes(memory, 0, memory.byteLength), before);
});

test("u32_last_valid_address_succeeds", () => {
  const memory = new ArrayBufferGuestMemory(8);

  assertGuestWriteOk(memory.writeU32(4, 0x89ab_cdef));

  strictEqual(readGuestValue(memory.readU32(4)), 0x89ab_cdef);
});

test("u32_crosses_end_faults", () => {
  const memory = new ArrayBufferGuestMemory(8);

  deepStrictEqual(memory.readU32(5), {
    ok: false,
    fault: { faultAddress: 5, faultSize: 4, guestAccess: "read" }
  });
});

test("u32_address_ffffffff_faults", () => {
  const memory = new ArrayBufferGuestMemory(8);

  deepStrictEqual(memory.readU32(0xffff_ffff), {
    ok: false,
    fault: { faultAddress: 0xffff_ffff, faultSize: 4, guestAccess: "read" }
  });
});
