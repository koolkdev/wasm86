import { deepStrictEqual } from "node:assert";

import { cpuStateResourceDefinition } from "#cpu/state.js";
import { guestMemoryResourceDefinition } from "#memory/resource.js";
import { programImportModuleName } from "#compiler/program/imports.js";

export function createGuestMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1 });
}

export function fillViewBytes(view: DataView, address: number, length: number, value: number): void {
  for (let index = 0; index < length; index += 1) {
    view.setUint8(address + index, value);
  }
}

export function readViewBytes(view: DataView, address: number, length: number): number[] {
  const bytes: number[] = [];

  for (let index = 0; index < length; index += 1) {
    bytes.push(view.getUint8(address + index));
  }

  return bytes;
}

export function assertMemoryImports(module: WebAssembly.Module): void {
  const memoryImports = WebAssembly.Module.imports(module)
    .filter((entry) => entry.kind === "memory")
    .map((entry) => ({ module: entry.module, name: entry.name, kind: entry.kind }));

  deepStrictEqual(memoryImports, [
    {
      module: programImportModuleName,
      name: cpuStateResourceDefinition.name,
      kind: "memory"
    },
    {
      module: programImportModuleName,
      name: guestMemoryResourceDefinition.name,
      kind: "memory"
    }
  ]);
}
