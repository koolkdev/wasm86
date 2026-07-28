import type { StorageEffects } from "#compiler/ir/effects.js";
import type { MemoryImport } from "#compiler/program/resources.js";
import { createMachineMemoryDefinition, type MachineMemoryDefinition } from "./machine-memory.js";
import {
  createPhysicalAddressSpaceDefinition,
  type PhysicalAddressSpaceDefinition
} from "./physical.js";
import type { MemoryAccess } from "./types.js";
import { createVirtualAccessDefinition } from "./virtual/access.js";
import { bindVirtualAddressSpace, type BoundVirtualAddressSpace } from "./virtual/host.js";

export type BoundMemory = BoundVirtualAddressSpace;

export type MemoryDefinition = Readonly<{
  physical: PhysicalAddressSpaceDefinition;
  machineMemory: MachineMemoryDefinition;
  resources: readonly MemoryImport[];
  access: MemoryAccess;
  effects: StorageEffects;
  bindHost(
    bindings: Readonly<{
      ram: WebAssembly.Memory;
      machine: WebAssembly.Memory;
    }>
  ): BoundMemory;
}>;

export function createMemoryDefinition(): MemoryDefinition {
  const physical = createPhysicalAddressSpaceDefinition();
  const machineMemory = createMachineMemoryDefinition();
  const virtualAccess = createVirtualAccessDefinition(physical, machineMemory);

  return {
    physical,
    machineMemory,
    resources: [...physical.resources, ...machineMemory.resources],
    access: virtualAccess.access,
    effects: virtualAccess.effects,
    bindHost: (bindings) => bindVirtualAddressSpace(physical, machineMemory, bindings)
  };
}
