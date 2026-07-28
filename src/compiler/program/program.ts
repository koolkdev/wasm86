import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { FunctionPlacement } from "#compiler/placement/place.js";
import type { IrFunction } from "#compiler/ir/function.js";
import type { FunctionType } from "#compiler/ir/function.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";
import type { FunctionImport } from "./imports.js";
import type { FunctionRef, TableRef } from "#compiler/ir/refs.js";
import type { FunctionExport } from "./exports.js";
import type { MemoryImport, ProgramResources, TableImport } from "./resources.js";

export type ProgramFunction = Readonly<{
  ref: FunctionRef;
  type: FunctionType;
  effects: StorageEffects;
  directFunctions: readonly FunctionRef[];
  indirectTypes: readonly FunctionType[];
  resources: readonly ResourceRef[];
  tables: readonly TableRef[];
  body: IrFunction;
  placement: FunctionPlacement;
}>;

export type FunctionDeclaration = FunctionDefinition | FunctionImport;

export type ProgramDeclarations = Readonly<{
  owner: object;
  resources: ProgramResources;
  tables: readonly TableImport[];
  functions: readonly FunctionDeclaration[];
  exports: readonly FunctionExport[];
}>;

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
