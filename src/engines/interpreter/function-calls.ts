import type { FunctionDefinition } from "#compiler/program/functions.js";

// Handler IR keeps semantic call targets until the closed program assigns
// their Wasm indexes during encoding.
export type FunctionCallBindings = Readonly<{
  functionIndices: ReadonlyMap<FunctionDefinition, number>;
}>;
