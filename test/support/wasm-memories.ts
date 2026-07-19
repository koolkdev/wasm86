import { cpuState } from "#cpu/state.js";
import { guestMemoryMinimumPages } from "#memory/constants.js";
import { wasmPageByteLength } from "#wasm/abi.js";

export type TestWasmMemories = Readonly<{
  cpuStateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
}>;

export function createTestWasmMemories(): TestWasmMemories {
  return {
    cpuStateMemory: new WebAssembly.Memory({
      initial: Math.ceil(cpuState.layout.byteLength / wasmPageByteLength)
    }),
    guestMemory: new WebAssembly.Memory({
      initial: guestMemoryMinimumPages
    })
  };
}
