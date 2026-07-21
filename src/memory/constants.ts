import { wasmPageByteLength } from "#compiler/program/pages.js";

// Flat guest accesses are limited to the first Wasm page.
// Guest memory must contain at least that page.
export const guestMemoryMinimumPages = 1;
export const guestMemoryMinimumByteLength =
  guestMemoryMinimumPages * wasmPageByteLength;
