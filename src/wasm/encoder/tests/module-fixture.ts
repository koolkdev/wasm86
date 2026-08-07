import { encodeWasmModule, type WasmModuleDescription } from "#wasm/encoder/module.js";

export function createTestModuleDescription(
  overrides: Partial<WasmModuleDescription>
): WasmModuleDescription {
  return {
    functionTypes: [],
    functionImports: [],
    memoryImports: [],
    tableImports: [],
    functions: [],
    globals: [],
    functionExports: [],
    ...overrides
  };
}

export function encodeTestModule(
  overrides: Partial<WasmModuleDescription>
): Uint8Array<ArrayBuffer> {
  return encodeWasmModule(createTestModuleDescription(overrides));
}
