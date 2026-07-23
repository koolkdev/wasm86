import {
  encodeWasmModule,
  type WasmModuleDescription
} from "#compiler/encoder/module.js";

export function testModuleDescription(
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
  return encodeWasmModule(testModuleDescription(overrides));
}
