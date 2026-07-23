import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  maximumWasmMemoryByteLength,
  maximumWasmMemoryPages,
  wasmPageByteLength,
  wasmPagesForByteLength
} from "#compiler/program/limits.js";

test("Wasm page arithmetic rounds byte lengths exactly once", () => {
  strictEqual(wasmPageByteLength, 0x1_0000);
  strictEqual(wasmPagesForByteLength(0), 0);
  strictEqual(wasmPagesForByteLength(1), 1);
  strictEqual(wasmPagesForByteLength(wasmPageByteLength), 1);
  strictEqual(wasmPagesForByteLength(wasmPageByteLength + 1), 2);
  strictEqual(
    wasmPagesForByteLength(maximumWasmMemoryByteLength),
    maximumWasmMemoryPages
  );
});

test("Wasm page arithmetic rejects invalid memory32 byte lengths", () => {
  for (const invalid of [
    -1,
    0.5,
    maximumWasmMemoryByteLength + 1,
    Number.POSITIVE_INFINITY,
    Number.NaN
  ]) {
    throws(
      () => wasmPagesForByteLength(invalid),
      /Wasm memory byte length out of range/
    );
  }
});
