export const wasmImport = {
  namespace: "wasm86",
  cpuStateMemoryName: "cpuState",
  guestMemoryName: "guest",
  linkTableName: "links"
} as const;

export const wasmMemoryIndex = {
  cpuState: 0,
  guest: 1
} as const;

export const wasmPageByteLength = 0x1_0000;

export const wasmBlockExportName = "run";
