import { createLayout, type Layout } from "#compiler/layout/layout.js";
import { resourceRef, type ResourceRef } from "#compiler/ir/resource.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { wasmPagesForByteLength } from "#compiler/program/limits.js";
import type { MemoryImport } from "#compiler/program/resources.js";
import { virtualStorageLayout } from "./layout.js";

const machineMemoryResourceDefinition = {
  id: "memory.machine",
  name: "machine"
} as const;

export type VirtualStorageDefinition = Readonly<{
  machineResource: ResourceRef;
  machineLayout: Layout;
  machineImport: MemoryImport;
  resources: readonly MemoryImport[];
}>;

export function createVirtualStorageDefinition(): VirtualStorageDefinition {
  const machineResource = resourceRef(machineMemoryResourceDefinition.id);
  const machineLayout = createLayout(
    "machine-memory",
    [virtualStorageLayout]
  );
  const machineImport: MemoryImport = {
    ref: machineResource,
    moduleName: programImportModuleName,
    name: machineMemoryResourceDefinition.name,
    limits: {
      minPages: wasmPagesForByteLength(machineLayout.byteLength)
    }
  };

  return {
    machineResource,
    machineLayout,
    machineImport,
    resources: [machineImport]
  };
}
