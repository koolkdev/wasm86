import { strictEqual } from "node:assert";
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
