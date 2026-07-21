import { wasmPagesForByteLength } from "#compiler/program/pages.js";
import { cpuState } from "#cpu/state.js";
import { guestMemoryMinimumPages } from "#memory/constants.js";

export type TestWasmMemories = Readonly<{
  cpuStateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
}>;

export function createTestWasmMemories(): TestWasmMemories {
  return {
    cpuStateMemory: new WebAssembly.Memory({
      initial: wasmPagesForByteLength(cpuState.layout.byteLength)
    }),
    guestMemory: new WebAssembly.Memory({
      initial: guestMemoryMinimumPages
    })
  };
}
