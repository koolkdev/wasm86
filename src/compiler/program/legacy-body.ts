import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import type {
  FunctionRef,
  GlobalRef,
  ResourceRef,
  SignatureRef,
  TableRef
} from "./refs.js";

export type LegacyEffects = "none" | "world";
export type LegacyTraps = "never" | "may";

export type LegacyFunctionBindings = Readonly<{
  typeIndex: number;
  functions: ReadonlyMap<FunctionRef, number>;
  resources: ReadonlyMap<ResourceRef, number>;
  globals: ReadonlyMap<GlobalRef, number>;
  tables: ReadonlyMap<TableRef, number>;
}>;

export type LegacyFunctionDeclaration = Readonly<{
  ref: FunctionRef;
  signature: SignatureRef;
  calls: readonly FunctionRef[];
  resources: readonly ResourceRef[];
  globals: readonly GlobalRef[];
  tables: readonly TableRef[];
  effects?: LegacyEffects;
  traps?: LegacyTraps;
  build(bindings: LegacyFunctionBindings): EncodedWasmFunctionBody;
}>;
