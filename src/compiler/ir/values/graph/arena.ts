import { assert } from "#common/assert.js";
import type { ValueDefinition, ValueFoldContext, ValueQuery } from "./definition.js";
import type { ValueGraph, ValueNode } from "./node.js";
import { valueId, type ValueId } from "#compiler/ir/value.js";
import { constantValue, unreachableValue } from "./leaves.js";
import { zeroTestValue } from "./zero-test.js";
import { ValueInterner } from "./interner.js";
import { createValueEntry, type ValueEntry } from "./entry.js";
import type { IntegerWidth } from "#compiler/integer/width.js";

type ArenaState = Readonly<{
  entries: ValueEntry[];
  interner: ValueInterner;
}>;

const noChildren: readonly ValueId[] = [];

export class ValueArena implements ValueGraph {
  readonly #entries: ValueEntry[];
  readonly #interner: ValueInterner;
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
    this.#entries = state?.entries ?? [];
    this.#interner = state?.interner ?? new ValueInterner();
  }

  childScope(): ValueArena {
    return new ValueArena({
      entries: this.#entries,
      interner: this.#interner.childScope()
    });
  }

  // Forks preserve the existing graph prefix while isolating later allocation.
  fork(): ValueArena {
    return new ValueArena({
      entries: [...this.#entries],
      interner: this.#interner.fork()
    });
  }

  sharesEntry(origin: ValueArena, id: ValueId): boolean {
    const entry = this.#entries[id];

    return entry !== undefined && entry === origin.#entries[id];
  }

  node(id: ValueId): ValueNode {
    return this.#entry(id).node;
  }

  size(): number {
    return this.#entries.length;
  }

  children(id: ValueId): readonly ValueId[] {
    return this.#entry(id).children;
  }

  bitWidth(id: ValueId): IntegerWidth {
    return this.#entry(id).bitWidth;
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

    return this.#interner.intern(definition, node, () =>
      this.#append(definition, node, children, width)
    );
  }

  #append<Args, Node extends ValueNode>(
    definition: ValueDefinition<Args, Node>,
    node: Node,
    children: readonly ValueId[],
    width: IntegerWidth
  ): ValueId {
    const id = valueId(this.#entries.length);

    this.#entries.push(
      createValueEntry(definition, {
        node,
        children,
        bitWidth: width
      })
    );
    return id;
  }

  #entry(id: ValueId): ValueEntry {
    const entry = this.#entries[id];

    assert(entry !== undefined, `unknown value id ${id}`);
    return entry;
  }
}
