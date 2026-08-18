import { assert } from "#common/assert.js";
import type { ResourceRef } from "#compiler/reference.js";
import { maximumWasmMemoryPages, type MemoryLimits } from "./limits.js";

export type MemoryImport = Readonly<{
  ref: ResourceRef;
  moduleName: string;
  name: string;
  limits: MemoryLimits;
}>;

export type ProgramResources = Readonly<{
  memoryImports: readonly MemoryImport[];
}>;

export function createProgramResources(memoryImports: readonly MemoryImport[]): ProgramResources {
  const resourceRefs = new Set<ResourceRef>();
  const fieldNamesByModule = new Map<string, Set<string>>();

  for (const memory of memoryImports) {
    assert(
      !resourceRefs.has(memory.ref),
      `duplicate program resource declaration: ${memory.ref.id}`
    );
    assert(
      memory.moduleName.length > 0,
      `memory ${memory.ref.id} has an empty external module name`
    );
    assert(memory.name.length > 0, `memory ${memory.ref.id} has an empty external field name`);
    const fieldNames = fieldNamesByModule.get(memory.moduleName);

    assert(
      fieldNames === undefined || !fieldNames.has(memory.name),
      `duplicate memory external identity: ${memory.moduleName}.${memory.name}`
    );
    validatePageCount(memory.limits.minPages, "memory minimum pages");
    if (memory.limits.maxPages !== undefined) {
      validatePageCount(memory.limits.maxPages, "memory maximum pages");
      assert(
        memory.limits.maxPages >= memory.limits.minPages,
        `memory ${memory.ref.id} maximum pages are below its minimum`
      );
    }

    resourceRefs.add(memory.ref);
    if (fieldNames === undefined) {
      fieldNamesByModule.set(memory.moduleName, new Set([memory.name]));
    } else {
      fieldNames.add(memory.name);
    }
  }

  return { memoryImports: [...memoryImports] };
}

function validatePageCount(value: number, label: string): void {
  assert(
    Number.isInteger(value) && value >= 0 && value <= maximumWasmMemoryPages,
    `${label} out of range: ${value}`
  );
}
