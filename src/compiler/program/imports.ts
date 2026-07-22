import type { StorageEffects } from "#compiler/ir/effects.js";
import type {
  CallTargetReferences,
  DirectFunctionTarget,
  InvocationEmitTarget
} from "#compiler/ir/invocation.js";
import type { FunctionType } from "./function-type.js";
import type { FunctionRef } from "./refs.js";

export const programImportModuleName = "wasm86";

export type FunctionImportDeclaration = Readonly<{
  ref: FunctionRef;
  type: FunctionType;
  effects: StorageEffects;
  moduleName: string;
  name: string;
}>;

export class FunctionImport implements DirectFunctionTarget {
  readonly ref: FunctionRef;
  readonly type: FunctionType;
  readonly effects: StorageEffects;
  readonly moduleName: string;
  readonly name: string;
  readonly #owner: object;

  constructor(declaration: FunctionImportDeclaration, owner: object) {
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

  get targetInputs(): readonly [] {
    return [];
  }

  get references(): CallTargetReferences {
    return { functions: [this], types: [], tables: [] };
  }

  emitCall(context: InvocationEmitTarget): void {
    context.body.callFunction(context.bindings.functionIndex(this.ref));
  }

  emitReturnCall(context: InvocationEmitTarget): void {
    context.body.returnCallFunction(context.bindings.functionIndex(this.ref));
  }
}
