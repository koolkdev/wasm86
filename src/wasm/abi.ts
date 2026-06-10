import type { Reg32 } from "#x86/types.js";
import { WASM_STATE_BYTE_LENGTH, WASM_STATE_OFFSETS } from "./state-layout.js";

export const wasmImport = {
  moduleName: "webwin32",
  stateMemoryName: "state",
  guestMemoryName: "guest",
  linkTableName: "links"
} as const;

export const wasmMemoryIndex = {
  state: 0,
  guest: 1
} as const;

export const wasmPageByteLength = 0x1_0000;

// Declared on the guest memory import, so instantiation enforces it.
export const wasmGuestMemoryMinPages = 1;
export const wasmGuestMemoryMinByteLength = wasmGuestMemoryMinPages * wasmPageByteLength;

export const wasmBlockExportName = "run";
export const wasmStatePtr = 32;

export const stateOffset = WASM_STATE_OFFSETS;
export const stateByteLength = WASM_STATE_BYTE_LENGTH;

export function reg32StateOffset(reg: Reg32): number {
  return WASM_STATE_OFFSETS[reg];
}
