import { createLayout, type Layout } from "#compiler/layout/layout.js";
import { resourceRef, type ResourceRef } from "#compiler/ir/resource.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { wasmPagesForByteLength } from "#compiler/program/limits.js";
import type { MemoryImport } from "#compiler/program/resources.js";
import { pageTableLayout } from "./virtual/layout.js";

const machineMemoryResourceDefinition = {
  id: "memory.machine",
  name: "machine"
} as const;

export type MachineMemoryDefinition = Readonly<{
  resource: ResourceRef;
  layout: Layout;
  memoryImport: MemoryImport;
  resources: readonly MemoryImport[];
}>;

export function createMachineMemoryDefinition(): MachineMemoryDefinition {
  const resource = resourceRef(machineMemoryResourceDefinition.id);
  const layout = createLayout(
    "machine-memory",
    [pageTableLayout]
  );
  const memoryImport: MemoryImport = {
    ref: resource,
    moduleName: programImportModuleName,
    name: machineMemoryResourceDefinition.name,
    limits: {
      minPages: wasmPagesForByteLength(layout.byteLength)
    }
  };

  return {
    resource,
    layout,
    memoryImport,
    resources: [memoryImport]
  };
}
