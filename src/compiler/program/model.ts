import type { WasmTableLimits } from "#compiler/encoder/module.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type { DirectFunctionTarget } from "#compiler/ir/invocation.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { BodyPlacement } from "#compiler/placement/place.js";
import type { IrFunction } from "#ir/function.js";
import type { FunctionType } from "./function-type.js";
import type { FunctionDefinition } from "./functions.js";
import type { FunctionImport } from "./imports.js";
import type {
  FunctionExportRef,
  FunctionRef,
  TableRef
} from "./refs.js";
import type { MemoryImport } from "./resources.js";

export type TableImport = Readonly<{
  ref: TableRef;
  moduleName: string;
  name: string;
  limits: WasmTableLimits;
}>;

export type FunctionExport = Readonly<{
  ref: FunctionExportRef;
  name: string;
  target: FunctionRef;
}>;

export type ProgramFunction = Readonly<{
  ref: FunctionRef;
  type: FunctionType;
  effects: StorageEffects;
  directTargets: readonly DirectFunctionTarget[];
  indirectTypes: readonly FunctionType[];
  resources: readonly ResourceRef[];
  tables: readonly TableRef[];
  body: IrFunction;
  placement: BodyPlacement;
}>;

export type FunctionDeclaration = FunctionDefinition | FunctionImport;

declare const programBrand: unique symbol;

export type ProgramData = Readonly<{
  functionTypes: readonly FunctionType[];
  memoryImports: readonly MemoryImport[];
  functionImports: readonly FunctionImport[];
  tables: readonly TableImport[];
  functions: readonly ProgramFunction[];
  exports: readonly FunctionExport[];
}>;

export type Program = ProgramData & Readonly<{ [programBrand]: true }>;
