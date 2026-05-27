import { deepStrictEqual } from "node:assert";

import { wasmImport } from "#wasm/abi.js";

export const startAddress = 0x1000;

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
    { module: wasmImport.moduleName, name: wasmImport.stateMemoryName, kind: "memory" },
    { module: wasmImport.moduleName, name: wasmImport.guestMemoryName, kind: "memory" }
  ]);
}
