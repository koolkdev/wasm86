import type { StorageEffects } from "#compiler/ir/effects.js";
import type { FunctionBuilder } from "#compiler/ir/builder/function.js";
import type { DirectCallTarget } from "#compiler/ir/invocation.js";
import type { FunctionType } from "#compiler/ir/function.js";
import { functionRef, type FunctionRef } from "#compiler/ir/refs.js";

export type BuildFunction = (fn: FunctionBuilder, self: FunctionDefinition) => void;

export type FunctionDefinitionOptions = Readonly<{
  ref: FunctionRef;
  type: FunctionType;
  effects: StorageEffects;
  owner: object | undefined;
  build: BuildFunction;
}>;

export class FunctionDefinition implements DirectCallTarget {
  readonly kind = "direct";
  readonly ref: FunctionRef;
  readonly type: FunctionType;
  readonly effects: StorageEffects;
  readonly #owner: object | undefined;
  readonly #buildFunction: BuildFunction;

  constructor(options: FunctionDefinitionOptions) {
    this.ref = options.ref;
    this.type = options.type;
    this.effects = {
      reads: [...options.effects.reads],
      writes: [...options.effects.writes]
    };
    this.#owner = options.owner;
    this.#buildFunction = options.build;
  }

  isAvailableTo(owner: object): boolean {
    return this.#owner === undefined || this.#owner === owner;
  }

  build(fn: FunctionBuilder): void {
    this.#buildFunction(fn, this);
  }
}

export type FunctionFamilyDefinition<TKey> = Readonly<{
  type: FunctionType;
  effects(key: TKey): StorageEffects;
  id(key: TKey): string;
  build(key: TKey, fn: FunctionBuilder, self: FunctionDefinition): void;
}>;

// Lazily supplies stable owner-defined function identities for a finite or
// otherwise key-addressable generated set. Program closure chooses members.
export class FunctionFamily<TKey> {
  readonly #definition: FunctionFamilyDefinition<TKey>;
  readonly #members = new Map<TKey, FunctionDefinition>();

  constructor(definition: FunctionFamilyDefinition<TKey>) {
    this.#definition = definition;
  }

  get(key: TKey): FunctionDefinition {
    const existing = this.#members.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const definition = new FunctionDefinition({
      ref: functionRef(this.#definition.id(key)),
      type: this.#definition.type,
      effects: this.#definition.effects(key),
      owner: undefined,
      build: (fn, self) => this.#definition.build(key, fn, self)
    });

    this.#members.set(key, definition);
    return definition;
  }
}
