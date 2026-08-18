import { wasmPagesForByteLength } from "#compiler/program/limits.js";
import type { ResourceRef } from "#compiler/reference.js";
import { createCpu, type Cpu } from "#cpu/cpu.js";
import { createExecutionModel, type ExecutionModel } from "#execution/model.js";
import { compileInterpreterProgram, type CompiledInterpreter } from "#interpreter/program.js";

export type MachineOptions = Readonly<{
  memoryByteLength: number;
}>;

export type Machine = Readonly<{
  memory: WebAssembly.Memory;
  cpu: Cpu;
}>;

const x86PageByteLength = 0x1000;
const x86AddressSpaceByteLength = 0x1_0000_0000;

type InterpreterCompilation = Readonly<{
  model: ExecutionModel;
  interpreter: CompiledInterpreter;
}>;

let interpreterCompilation: InterpreterCompilation | undefined;

export function createMachine(options: MachineOptions): Machine {
  const { memoryByteLength } = options;

  if (
    !Number.isSafeInteger(memoryByteLength) ||
    memoryByteLength <= 0 ||
    memoryByteLength > x86AddressSpaceByteLength ||
    memoryByteLength % x86PageByteLength !== 0
  ) {
    throw new RangeError(
      `memoryByteLength must be a positive 4 KiB-aligned integer no greater than 4 GiB: ` +
        memoryByteLength
    );
  }

  const { model, interpreter } = getInterpreterCompilation();
  const memoryDefinition = model.memory;
  const physical = memoryDefinition.physical;
  const machineMemoryDefinition = memoryDefinition.machineMemory;
  const initialPages = wasmPagesForByteLength(memoryByteLength);
  const maximumPages = physical.ramImport.limits.maxPages;

  const memory = createWasmMemory(initialPages, maximumPages);
  const { minPages, maxPages } = machineMemoryDefinition.memoryImport.limits;
  const machineMemory = createWasmMemory(minPages, maxPages);
  const boundMemory = memoryDefinition.bindHost({
    ram: memory,
    machine: machineMemory
  });

  boundMemory.initializeIdentity();
  const sharedMemories = new Map<ResourceRef, WebAssembly.Memory>([
    [physical.ramResource, memory],
    [machineMemoryDefinition.resource, machineMemory]
  ]);
  const cpu = createCpu({
    state: model.cpuState,
    sharedMemories,
    interpreter
  });

  return {
    memory,
    cpu
  };
}

function getInterpreterCompilation(): InterpreterCompilation {
  if (interpreterCompilation === undefined) {
    const model = createExecutionModel();

    interpreterCompilation = {
      model,
      interpreter: compileInterpreterProgram(model)
    };
  }

  return interpreterCompilation;
}

function createWasmMemory(initial: number, maximum: number | undefined): WebAssembly.Memory {
  return new WebAssembly.Memory(maximum === undefined ? { initial } : { initial, maximum });
}
