import { wasmPageByteLength } from "#compiler/program/limits.js";

// Guest RAM contains at least one Wasm page. Virtual initialization maps the
// complete live backing, including the host's page rounding.
export const guestMemoryMinimumPages = 1;
export const guestMemoryMinimumByteLength =
  guestMemoryMinimumPages * wasmPageByteLength;
