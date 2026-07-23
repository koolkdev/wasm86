import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  maximumWasmMemoryByteLength,
  maximumWasmMemoryPages,
  wasmPageByteLength,
  wasmPagesForByteLength
} from "#compiler/program/limits.js";

test("Wasm memory limits use the memory32 page size and maximum", () => {
  strictEqual(wasmPageByteLength, 0x1_0000);
  strictEqual(maximumWasmMemoryPages, 0x1_0000);
  strictEqual(maximumWasmMemoryByteLength, 0x1_0000_0000);
});

test("Wasm page counts round up partial pages", () => {
  strictEqual(wasmPagesForByteLength(0), 0);
  strictEqual(wasmPagesForByteLength(1), 1);
  strictEqual(wasmPagesForByteLength(0x1_0000), 1);
  strictEqual(wasmPagesForByteLength(0x1_0001), 2);
  strictEqual(wasmPagesForByteLength(0x1_0000_0000), 0x1_0000);
});

test("Wasm page arithmetic rejects invalid memory32 byte lengths", () => {
  for (const invalid of [
    -1,
    0.5,
    0x1_0000_0001,
    Number.POSITIVE_INFINITY,
    Number.NaN
  ]) {
    throws(
      () => wasmPagesForByteLength(invalid),
      /Wasm memory byte length out of range/
    );
  }
});
