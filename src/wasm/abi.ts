export const wasmImport = {
  namespace: "wasm86",
  cpuStateMemoryName: "cpuState",
  guestMemoryName: "guest",
  machineMemoryName: "machine",
  linkTableName: "links"
} as const;

export const wasmMemoryIndex = {
  cpuState: 0,
  guest: 1,
  machine: 2
} as const;

export const wasmPageByteLength = 0x1_0000;

// Declared on the guest memory import, so instantiation enforces it.
export const wasmGuestMemoryMinPages = 1;
export const wasmGuestMemoryMinByteLength = wasmGuestMemoryMinPages * wasmPageByteLength;

export const wasmBlockExportName = "run";
