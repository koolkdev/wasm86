import type { FunctionRef, ResourceRef } from "#compiler/reference.js";

// The module layer resolves the symbolic references used by one function.
export type WasmFunctionBindings = Readonly<{
  functionIndex: (ref: FunctionRef) => number;
  memoryIndex: (ref: ResourceRef) => number;
}>;
