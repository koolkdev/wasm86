import { resourceRef } from "#compiler/ir/resource.js";
import { createLayout } from "#compiler/layout/layout.js";
import type { LayoutStructure } from "#compiler/layout/structure.js";
import type { MemoryImport } from "#compiler/program/resources.js";
import { wasmPagesForByteLength } from "#compiler/program/limits.js";
import {
  StateAccess,
  type StateResource
} from "#core/state/access.js";
import { flagStateLayout } from "#core/flags/layout.js";
import { coreStateLayout } from "#core/state/layout.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { instructionCounterLayout } from "./instruction-count.js";

const cpuStateStructures: readonly LayoutStructure[] = [
  coreStateLayout,
  flagStateLayout,
  instructionCounterLayout
];

export const cpuStateResourceDefinition = {
  id: "cpu.state",
  name: "cpuState"
} as const;

export type CpuStateDefinition = StateResource & Readonly<{
  access: StateAccess;
  memoryImport: MemoryImport;
}>;

export function createCpuStateDefinition(): CpuStateDefinition {
  const resource = resourceRef(cpuStateResourceDefinition.id);
  const layout = createLayout("execution-state", cpuStateStructures);
  const state: StateResource = { resource, layout };
  const access = new StateAccess(state);

  return {
    resource,
    layout,
    access,
    memoryImport: {
      ref: resource,
      moduleName: programImportModuleName,
      name: cpuStateResourceDefinition.name,
      limits: { minPages: wasmPagesForByteLength(layout.byteLength) }
    }
  };
}
