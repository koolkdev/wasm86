import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import type {
  FunctionRef,
  GlobalRef,
  SignatureRef,
  TableRef
} from "./refs.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { IrBlock } from "#ir/block.js";
import type { BodyPlacement } from "#compiler/placement/place.js";
import type { FunctionDefinition } from "./functions.js";
import type { FunctionType } from "./function-type.js";

export type LegacyEffects = "none" | "world";

export type LegacyFunctionBindings = Readonly<{
  typeIndex: number;
  typeIndices: ReadonlyMap<FunctionType, number>;
  functions: ReadonlyMap<FunctionRef, number>;
  definitionIndices: ReadonlyMap<FunctionDefinition, number>;
  resources: ReadonlyMap<ResourceRef, number>;
  globals: ReadonlyMap<GlobalRef, number>;
  tables: ReadonlyMap<TableRef, number>;
  placements: ReadonlyMap<IrBlock, BodyPlacement>;
}>;

export type LegacyIrBlockDeclaration = Readonly<{
  block: IrBlock;
  allowImplicitEntryFallthrough: boolean;
}>;

export type LegacyFunctionDeclaration = Readonly<{
  ref: FunctionRef;
  signature: SignatureRef;
  calls: readonly (FunctionRef | FunctionDefinition)[];
  resources: readonly ResourceRef[];
  globals: readonly GlobalRef[];
  tables: readonly TableRef[];
  irBlocks: readonly LegacyIrBlockDeclaration[];
  effects?: LegacyEffects;
  build(bindings: LegacyFunctionBindings): EncodedWasmFunctionBody;
}>;
