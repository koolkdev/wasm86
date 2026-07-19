import type { FunctionDefinition } from "#compiler/program/functions.js";
import type { FunctionType } from "#compiler/program/function-type.js";
import type { TableRef } from "#compiler/program/refs.js";
import type { ResourceRef } from "#compiler/ir/resource.js";

// Handler IR keeps semantic call targets until the closed program assigns
// their Wasm indexes during encoding.
export type FunctionCallBindings = Readonly<{
  functionIndices: ReadonlyMap<FunctionDefinition, number>;
  typeIndices: ReadonlyMap<FunctionType, number>;
  tableIndices: ReadonlyMap<TableRef, number>;
  resourceIndices: ReadonlyMap<ResourceRef, number>;
}>;
