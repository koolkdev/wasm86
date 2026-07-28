import { createProgramResources, type ProgramResources } from "#compiler/program/resources.js";
import { createCpuStateDefinition, type CpuStateDefinition } from "#cpu/state.js";
import { createMemoryDefinition, type MemoryDefinition } from "#memory/access.js";

// Static definitions used to build reusable execution code. Live Cpu state and
// Machine memories are supplied only when a compiled program is instantiated.
export type ExecutionModel = Readonly<{
  resources: ProgramResources;
  cpuState: CpuStateDefinition;
  memory: MemoryDefinition;
}>;

export function createExecutionModel(): ExecutionModel {
  const cpuState = createCpuStateDefinition();
  const memory = createMemoryDefinition();

  return {
    resources: createProgramResources([cpuState.memoryImport, ...memory.resources]),
    cpuState,
    memory
  };
}
