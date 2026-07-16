import type { WasmMemoryLimits } from "#compiler/encoder/memory.js";
import type { WasmTableLimits } from "#compiler/encoder/module.js";
import type { wasmValueType } from "#compiler/encoder/types.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type { BodyPlacement } from "#compiler/placement/place.js";
import type { IrBlock } from "#ir/block.js";
import type { IrFunction } from "#ir/function.js";
import type { FunctionType } from "./function-type.js";
import type { FunctionDefinition } from "./functions.js";
import type {
  LegacyEffects,
  LegacyFunctionDeclaration
} from "./legacy-body.js";
import type {
  ExportRef,
  FunctionRef,
  GlobalRef,
  ResourceRef,
  SignatureRef,
  TableRef
} from "./refs.js";

export type Signature = Readonly<{
  ref: SignatureRef;
  type: FunctionType;
}>;

export type MemoryImport = Readonly<{
  ref: ResourceRef;
  moduleName: string;
  name: string;
  limits: WasmMemoryLimits;
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
  ref: ExportRef;
  name: string;
  target: FunctionRef;
}>;

export type LegacyFunction = Readonly<{
  kind: "legacy";
  ref: FunctionRef;
  signature: SignatureRef;
  calls: readonly FunctionRef[];
  callTargets: readonly FunctionDefinition[];
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
  signature: SignatureRef;
  callTargets: readonly FunctionDefinition[];
  body: IrFunction;
  placement: BodyPlacement;
}>;

export type FunctionDeclaration = LegacyFunction | FunctionDefinition;
export type ProgramFunction = LegacyFunction | DefinedFunction;

declare const programBrand: unique symbol;

export type ProgramData = Readonly<{
  signatures: readonly Signature[];
  memories: readonly MemoryImport[];
  tables: readonly TableImport[];
  globals: readonly InternalGlobal[];
  functions: readonly ProgramFunction[];
  exports: readonly FunctionExport[];
  placements: ReadonlyMap<IrBlock, BodyPlacement>;
}>;

export type Program = ProgramData & Readonly<{ [programBrand]: true }>;
