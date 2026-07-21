import { testExecutionModel } from "#test/support/execution-model.js";

export type TestWasmMemories = Readonly<{
  cpuStateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
}>;

export function createTestWasmMemories(): TestWasmMemories {
  return {
    cpuStateMemory: new WebAssembly.Memory({
      initial: testExecutionModel.cpuState.memoryImport.limits.minPages
    }),
    guestMemory: new WebAssembly.Memory({
      initial: testExecutionModel.guestMemory.memoryImport.limits.minPages
    })
  };
}
