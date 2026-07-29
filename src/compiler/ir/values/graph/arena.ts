import { assert } from "#common/assert.js";
import type { ValueDefinition, ValueFoldContext, ValueQuery } from "./definition.js";
import type { ValueGraph, ValueNode } from "./node.js";
import { valueId, type ValueId, type ValueType } from "#compiler/value.js";
import { constantValue, unreachableValue } from "./leaves.js";
import { zeroTestValue } from "./zero-test.js";
import {
  cloneInternTable,
  cloneScopedInterning,
  createInternTable,
  createScopedInterning,
  internScopedValue,
  internValue,
  type InternTable,
  type ScopedInterning
} from "./interning.js";
import { createValueEntry, type ValueEntry } from "./entry.js";
import { carrierTypeForWidth, type ValueWidth } from "#compiler/integer/width.js";

type ValueStorage = Readonly<{
  entries: ValueEntry[];
  canonicalInterned: InternTable;
}>;

type ArenaState = Readonly<{
  storage: ValueStorage;
  scopedInterning: ScopedInterning;
}>;

const noChildren: readonly ValueId[] = [];

export class ValueArena implements ValueGraph {
  readonly #storage: ValueStorage;
  readonly #scopedInterning: ScopedInterning;
  readonly #query: ValueQuery = {
    bitWidth: (id) => this.bitWidth(id),
    constant: (id) => this.constant(id)
  };
  readonly #foldContext: ValueFoldContext = {
    ...this.#query,
    constantValue: (width, value) => this.create(constantValue, { width, value }),
    unreachable: (width) => this.create(unreachableValue, { width }),
    eqz: (value) => this.create(zeroTestValue, { operator: "eqz", value }),
    nonzero: (value) => this.create(zeroTestValue, { operator: "nonzero", value })
  };

  constructor(state?: ArenaState) {
    this.#storage = state?.storage ?? {
      entries: [],
      canonicalInterned: createInternTable()
    };
    this.#scopedInterning = state?.scopedInterning ?? createScopedInterning();
  }

  childScope(): ValueArena {
    return new ValueArena({
      storage: this.#storage,
      scopedInterning: createScopedInterning(this.#scopedInterning)
    });
  }

  // Forks preserve the existing graph prefix while isolating later allocation.
  fork(): ValueArena {
    return new ValueArena({
      storage: {
        entries: [...this.#storage.entries],
        canonicalInterned: cloneInternTable(this.#storage.canonicalInterned)
      },
      scopedInterning: cloneScopedInterning(this.#scopedInterning)
    });
  }

  sharesEntry(origin: ValueArena, id: ValueId): boolean {
    const entry = this.#storage.entries[id];

    return entry !== undefined && entry === origin.#storage.entries[id];
  }

  node(id: ValueId): ValueNode {
    return this.#entry(id).node;
  }

  size(): number {
    return this.#storage.entries.length;
  }

  children(id: ValueId): readonly ValueId[] {
    return this.#entry(id).children;
  }

  bitWidth(id: ValueId): ValueWidth {
    return this.#entry(id).bitWidth;
  }

  valueType(id: ValueId): ValueType {
    return carrierTypeForWidth(this.bitWidth(id));
  }

  isUnreachable(id: ValueId): boolean {
    return this.node(id).kind === "unreachable";
  }

  constant(id: ValueId): bigint | undefined {
    return this.#entry(id).constant;
  }

  constValue(id: ValueId): number | undefined {
    if (this.bitWidth(id) === 64) {
      return undefined;
    }
    const value = this.constant(id);

    return value === undefined ? undefined : Number(BigInt.asIntN(32, value));
  }

  create<Args, Node extends ValueNode>(
    definition: ValueDefinition<Args, Node>,
    args: Args
  ): ValueId {
    const node = definition.create(args);
    const children = definition.children?.(node) ?? noChildren;

    for (const child of children) {
      this.#entry(child);
    }
    definition.validate?.(node, this.#query);
    const width = definition.bitWidth(node, this.#query);
    const folded = definition.fold?.(node, this.#foldContext);

    if (folded !== undefined) {
      assert(
        this.bitWidth(folded) === width,
        `${node.kind} fold produced ${this.bitWidth(folded)} bits, expected ${width}`
      );
      return folded;
    }

    switch (definition.identity.kind) {
      case "occurrence":
        return this.#append(definition, node, children, width);
      case "canonical":
        return internValue(
          this.#storage.canonicalInterned,
          definition,
          definition.identity.key(node),
          () => this.#append(definition, node, children, width)
        );
      case "scoped":
        return internScopedValue(
          this.#scopedInterning,
          definition,
          definition.identity.key(node),
          () => this.#append(definition, node, children, width)
        );
    }
  }

  #append<Args, Node extends ValueNode>(
    definition: ValueDefinition<Args, Node>,
    node: Node,
    children: readonly ValueId[],
    width: ValueWidth
  ): ValueId {
    const id = valueId(this.#storage.entries.length);

    this.#storage.entries.push(
      createValueEntry(definition, {
        node,
        children,
        bitWidth: width
      })
    );
    return id;
  }

  #entry(id: ValueId): ValueEntry {
    const entry = this.#storage.entries[id];

    assert(entry !== undefined, `unknown value id ${id}`);
    return entry;
  }
}
