import { buildFunction, type FunctionBuilder } from "#compiler/function/builder/function.js";
import type { FunctionBody } from "#compiler/function/body.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { StorageEffects } from "#compiler/function/storage.js";
import type { FunctionType } from "#compiler/function/type.js";
import { functionRef, type FunctionRef } from "#compiler/reference.js";

export type BuildFunction<Type extends FunctionType> = (
  fn: FunctionBuilder<Type>,
  self: FunctionDefinition<Type>
) => void;

type FunctionDefinitionOptions<Type extends FunctionType> = Readonly<{
  ref: FunctionRef;
  type: Type;
  effects: StorageEffects;
  owner: object | undefined;
  buildStability: "dynamic" | "stable";
  build: BuildFunction<NoInfer<Type>>;
}>;

export class FunctionDefinition<
  Type extends FunctionType = FunctionType
> implements CallTarget<Type> {
  readonly kind = "direct";
  readonly ref: FunctionRef;
  readonly type: Type;
  readonly effects: StorageEffects;
  readonly buildStability: "dynamic" | "stable";
  readonly #owner: object | undefined;
  readonly #buildFunction: () => FunctionBody<Type>;

  constructor(options: FunctionDefinitionOptions<Type>) {
    this.ref = options.ref;
    this.type = options.type;
    this.effects = {
      reads: [...options.effects.reads],
      writes: [...options.effects.writes]
    };
    this.buildStability = options.buildStability;
    this.#owner = options.owner;
    this.#buildFunction = () => buildFunction(this.type, (fn) => options.build(fn, this));
  }

  isAvailableTo(owner: object): boolean {
    return this.#owner === undefined || this.#owner === owner;
  }

  build(): FunctionBody<Type> {
    return this.#buildFunction();
  }
}

type FunctionFamilyDefinition<Key, Type extends FunctionType> = Readonly<{
  type: Type;
  effects(key: Key): StorageEffects;
  id(key: Key): string;
  build(
    key: Key,
    fn: FunctionBuilder<NoInfer<Type>>,
    self: FunctionDefinition<NoInfer<Type>>
  ): void;
}>;

// Lazily supplies stable owner-defined function identities for a finite or
// otherwise key-addressable generated set. Module reachability chooses members.
export class FunctionFamily<Key, Type extends FunctionType> {
  readonly #definition: FunctionFamilyDefinition<Key, Type>;
  readonly #members = new Map<Key, FunctionDefinition<Type>>();

  constructor(definition: FunctionFamilyDefinition<Key, Type>) {
    this.#definition = definition;
  }

  get(key: Key): FunctionDefinition<Type> {
    const existing = this.#members.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const definition = new FunctionDefinition({
      ref: functionRef(this.#definition.id(key)),
      type: this.#definition.type,
      effects: this.#definition.effects(key),
      owner: undefined,
      buildStability: "stable",
      build: (fn, self) => this.#definition.build(key, fn, self)
    });

    this.#members.set(key, definition);
    return definition;
  }
}
