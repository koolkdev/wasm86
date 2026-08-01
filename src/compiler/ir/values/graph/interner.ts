import { InternTable } from "#common/intern-table.js";
import type { ValueDefinition, ValueKey } from "./definition.js";
import type { ValueNode } from "./node.js";
import type { ValueId } from "#compiler/value.js";

type ValueInternTable = InternTable<object, ValueKey, ValueId>;

type ValueInternerState = Readonly<{
  canonical: ValueInternTable;
  scoped: ValueInternTable;
  parent?: ValueInterner;
}>;

export class ValueInterner {
  // Canonical identities span the arena family; scoped identities flow only to descendants.
  readonly #canonical: ValueInternTable;
  readonly #scoped: ValueInternTable;
  readonly #parent: ValueInterner | undefined;

  constructor(state?: ValueInternerState) {
    this.#canonical = state?.canonical ?? new InternTable();
    this.#scoped = state?.scoped ?? new InternTable();
    this.#parent = state?.parent;
  }

  childScope(): ValueInterner {
    return new ValueInterner({
      canonical: this.#canonical,
      scoped: new InternTable(),
      parent: this
    });
  }

  fork(): ValueInterner {
    return this.#clone(this.#canonical.clone());
  }

  intern<Args, Node extends ValueNode>(
    definition: ValueDefinition<Args, Node>,
    node: Node,
    create: () => ValueId
  ): ValueId {
    switch (definition.identity.kind) {
      case "occurrence":
        return create();
      case "canonical":
        return this.#canonical.intern(definition, definition.identity.key(node), create);
      case "scoped":
        return this.#internScoped(definition, definition.identity.key(node), create);
    }
  }

  #internScoped(definition: object, key: readonly ValueKey[], create: () => ValueId): ValueId {
    for (let scope: ValueInterner | undefined = this; scope !== undefined; scope = scope.#parent) {
      const existing = scope.#scoped.get(definition, key);

      if (existing !== undefined) {
        return existing;
      }
    }

    return this.#scoped.intern(definition, key, create);
  }

  #clone(canonical: ValueInternTable): ValueInterner {
    return new ValueInterner({
      canonical,
      scoped: this.#scoped.clone(),
      ...(this.#parent === undefined ? {} : { parent: this.#parent.#clone(canonical) })
    });
  }
}
