import type { WasmTableLimits } from "#compiler/encoder/module.js";
import type { wasmValueType } from "#compiler/encoder/types.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type { DirectFunctionTarget } from "#compiler/ir/invocation.js";
import type { BodyPlacement } from "#compiler/placement/place.js";
import type { IrBlock } from "#ir/block.js";
import type { IrFunction } from "#ir/function.js";
import type { FunctionType } from "./function-type.js";
import type { FunctionDefinition } from "./functions.js";
import type { FunctionImport } from "./imports.js";
import type {
  LegacyEffects,
  LegacyFunctionDeclaration
} from "./legacy-body.js";
import type {
  FunctionExportRef,
  FunctionRef,
  GlobalRef,
  SignatureRef,
  TableRef
} from "./refs.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { MemoryImport } from "./resources.js";

export type Signature = Readonly<{
  ref: SignatureRef;
  type: FunctionType;
}>;

export type TableImport = Readonly<{
  ref: TableRef;
  moduleName: string;
  name: string;
  limits: WasmTableLimits;
}>;

export type InternalGlobal = Readonly<{
  ref: GlobalRef;
  type: typeof wasmValueType.i32;
  mutable: true;
  initialValue: number;
}>;

export type FunctionExport = Readonly<{
  ref: FunctionExportRef;
  name: string;
  target: FunctionRef;
}>;

export type LegacyFunction = Readonly<{
  kind: "legacy";
  ref: FunctionRef;
  signature: SignatureRef;
  calls: readonly FunctionRef[];
  callTargets: readonly DirectFunctionTarget[];
  indirectTypes: readonly FunctionType[];
  resources: readonly ResourceRef[];
  globals: readonly GlobalRef[];
  tables: readonly TableRef[];
  irBlocks: LegacyFunctionDeclaration["irBlocks"];
  effects: LegacyEffects;
  eliminable: false;
  build: LegacyFunctionDeclaration["build"];
}>;

export type DefinedFunction = Readonly<{
  kind: "function";
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

export type FunctionDeclaration = LegacyFunction | FunctionDefinition | FunctionImport;
export type ProgramFunction = LegacyFunction | DefinedFunction;

declare const programBrand: unique symbol;

export type ProgramData = Readonly<{
  functionTypes: readonly FunctionType[];
  signatures: readonly Signature[];
  memoryImports: readonly MemoryImport[];
  functionImports: readonly FunctionImport[];
  tables: readonly TableImport[];
  globals: readonly InternalGlobal[];
  functions: readonly ProgramFunction[];
  exports: readonly FunctionExport[];
  placements: ReadonlyMap<IrBlock, BodyPlacement>;
}>;

export type Program = ProgramData & Readonly<{ [programBrand]: true }>;
