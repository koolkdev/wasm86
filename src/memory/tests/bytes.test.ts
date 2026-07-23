import { strictEqual } from "node:assert";
import { test } from "node:test";

import { readBackingByte, writeBackingBytes } from "#memory/bytes.js";

test("reads and writes backing bytes at bounds", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const last = memory.buffer.byteLength - 1;

  strictEqual(writeBackingBytes(memory, 0, [0x12]), undefined);
  strictEqual(writeBackingBytes(memory, last, [0x34]), undefined);
  strictEqual(readBackingByte(memory, 0), 0x12);
  strictEqual(readBackingByte(memory, last), 0x34);
  strictEqual(readBackingByte(memory, last + 1), undefined);
  strictEqual(readBackingByte(memory, -1), undefined);
  strictEqual(readBackingByte(memory, 1.5), undefined);
  strictEqual(writeBackingBytes(memory, last + 1, [0x56]), last + 1);
});

test("refreshes backing views after memory growth", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const address = memory.buffer.byteLength;
  memory.grow(1);

  strictEqual(writeBackingBytes(memory, address, [0x78]), undefined);
  strictEqual(readBackingByte(memory, address), 0x78);
});

test("writes sequentially and returns the first failing address", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const last = memory.buffer.byteLength - 1;

  strictEqual(writeBackingBytes(memory, last, [0xaa, 0xbb]), last + 1);
  strictEqual(readBackingByte(memory, last), 0xaa);
});
