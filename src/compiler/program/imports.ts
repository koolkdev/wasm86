import type { CallTarget } from "#compiler/function/invocation.js";
import type { StorageEffects } from "#compiler/function/storage.js";
import type { FunctionType } from "#compiler/function/type.js";
import type { FunctionRef } from "#compiler/reference.js";

export const programImportModuleName = "wasm86";

export type FunctionImportDeclaration<Type extends FunctionType = FunctionType> = Readonly<{
  ref: FunctionRef;
  type: Type;
  effects: StorageEffects;
  moduleName: string;
  name: string;
}>;

export class FunctionImport<Type extends FunctionType = FunctionType> implements CallTarget<Type> {
  readonly kind = "direct";
  readonly ref: FunctionRef;
  readonly type: Type;
  readonly effects: StorageEffects;
  readonly moduleName: string;
  readonly name: string;
  readonly #owner: object;

  constructor(declaration: FunctionImportDeclaration<Type>, owner: object) {
    this.ref = declaration.ref;
    this.type = declaration.type;
    this.effects = {
      reads: [...declaration.effects.reads],
      writes: [...declaration.effects.writes]
    };
    this.moduleName = declaration.moduleName;
    this.name = declaration.name;
    this.#owner = owner;
  }

  isAvailableTo(owner: object): boolean {
    return this.#owner === owner;
  }
}
