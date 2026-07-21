import {
  createProgramResources,
  type ProgramResources
} from "#compiler/program/resources.js";
import {
  createCpuStateDefinition,
  type CpuStateDefinition
} from "#cpu/state.js";
import {
  createGuestMemoryDefinition,
  type GuestMemoryDefinition
} from "#memory/access.js";

// Static definitions used to build reusable execution code. Live Cpu state and
// Machine memories are supplied only when a compiled program is instantiated.
export type ExecutionModel = Readonly<{
  resources: ProgramResources;
  cpuState: CpuStateDefinition;
  guestMemory: GuestMemoryDefinition;
}>;

export function createExecutionModel(): ExecutionModel {
  const cpuState = createCpuStateDefinition();
  const guestMemory = createGuestMemoryDefinition();

  return {
    resources: createProgramResources([
      cpuState.memoryImport,
      guestMemory.memoryImport
    ]),
    cpuState,
    guestMemory
  };
}
