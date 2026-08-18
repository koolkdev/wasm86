import type { ResourceRef } from "#compiler/reference.js";
import type { GuestMemoryReader } from "#memory/types.js";
import { testExecutionModel } from "#test/support/execution-model.js";

export type TestGuestMemoryBinding = Readonly<{
  guestMemory: WebAssembly.Memory;
  machineMemory: WebAssembly.Memory;
  reader: GuestMemoryReader;
  memoryBindings: ReadonlyMap<ResourceRef, WebAssembly.Memory>;
}>;

export type TestWasmMemories = TestGuestMemoryBinding &
  Readonly<{
    cpuStateMemory: WebAssembly.Memory;
    programMemories: ReadonlyMap<ResourceRef, WebAssembly.Memory>;
  }>;

export function createTestGuestMemoryBinding(
  guestMemory: WebAssembly.Memory
): TestGuestMemoryBinding {
  const machineMemoryDefinition = testExecutionModel.memory.machineMemory;
  const machineMemory = new WebAssembly.Memory({
    initial: machineMemoryDefinition.memoryImport.limits.minPages
  });
  const boundMemory = testExecutionModel.memory.bindHost({
    ram: guestMemory,
    machine: machineMemory
  });

  boundMemory.initializeIdentity();
  return {
    guestMemory,
    machineMemory,
    reader: boundMemory.reader,
    memoryBindings: new Map([
      [testExecutionModel.memory.physical.ramResource, guestMemory],
      [machineMemoryDefinition.resource, machineMemory]
    ])
  };
}

export function createTestWasmMemories(): TestWasmMemories {
  const cpuStateMemory = new WebAssembly.Memory({
    initial: testExecutionModel.cpuState.memoryImport.limits.minPages
  });
  const guestMemory = new WebAssembly.Memory({
    initial: testExecutionModel.memory.physical.ramImport.limits.minPages
  });
  const guest = createTestGuestMemoryBinding(guestMemory);

  return {
    ...guest,
    cpuStateMemory,
    programMemories: new Map([
      [testExecutionModel.cpuState.resource, cpuStateMemory],
      ...guest.memoryBindings
    ])
  };
}
