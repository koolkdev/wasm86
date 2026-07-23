import { assert } from "#common/assert.js";
import type { IntegerWidth } from "./types.js";
import { binaryValue, type BinaryOperator } from "./binary.js";
import type { ValueBuilder } from "./builder.js";
import {
  compareIsSigned,
  comparisonValue,
  type CompareOperator
} from "./comparison.js";
import {
  type ValueBoundsContext,
  type ValueCaptureMode,
  type ValueDefinition,
  type ValueFoldContext,
  type ValueKey
} from "./definition.js";
import {
  nodeOutputValue,
  constant64Value,
  constantValue,
  loopInputValue,
  parameterValue,
  unreachableValue
} from "./leaves.js";
import { selectValue } from "./select.js";
import { unaryValue, type UnaryOperator } from "./unary.js";
import { extendValue } from "./extend.js";
import { truncateValue } from "./truncate.js";
import { valueId } from "./id.js";
import {
  type ValueId,
  type ValueInput,
  type ValueType,
  type WidthBounds
} from "./types.js";
import { unboundedWidthBounds } from "./width-bounds.js";

type AnyValueDefinition =
  | typeof nodeOutputValue
  | typeof binaryValue
  | typeof comparisonValue
  | typeof constant64Value
  | typeof constantValue
  | typeof extendValue
  | typeof loopInputValue
  | typeof parameterValue
  | typeof selectValue
  | typeof truncateValue
  | typeof unreachableValue
  | typeof unaryValue;

export type ValueNode = ReturnType<AnyValueDefinition["create"]>;

// The table stores different definition/node pairs in one array. This adapter
// preserves each pair's generic relationship without casts or per-value bound
// closures, while exposing one small non-generic interface to the table.
interface StoredValue {
  readonly node: ValueNode;
  children(): readonly ValueId[];
  resultType(): ValueType;
  bounds(context: ValueBoundsContext): WidthBounds;
  mayTrap(): boolean;
  isNonTrapping(): boolean;
  captureMode(): ValueCaptureMode;
  constValue(): number | undefined;
  integerValue(): bigint | undefined;
}

class StoredValueEntry<Args, Node extends ValueNode> implements StoredValue {
  readonly #children: readonly ValueId[];

  constructor(
    private readonly definition: ValueDefinition<Args, Node>,
    readonly node: Node,
    inputs: readonly ValueInput[],
    private readonly intrinsicMayTrap: boolean,
    private readonly nonTrapping: boolean
  ) {
    this.#children = inputs.length === 0
      ? noChildren
      : inputs.map((input) => input.value);
  }

  children(): readonly ValueId[] {
    return this.#children;
  }

  resultType(): ValueType {
    return this.definition.resultType(this.node);
  }

  bounds(context: ValueBoundsContext): WidthBounds {
    return this.definition.widthBounds(this.node, context);
  }

  mayTrap(): boolean {
    return this.intrinsicMayTrap;
  }

  isNonTrapping(): boolean {
    return this.nonTrapping;
  }

  captureMode(): ValueCaptureMode {
    return this.definition.captureMode;
  }

  constValue(): number | undefined {
    return this.definition.constValue?.(this.node);
  }

  integerValue(): bigint | undefined {
    return this.definition.integerValue?.(this.node);
  }
}

type InternNode = {
  readonly children: Map<ValueKey, InternNode>;
  value: ValueId | undefined;
};

type InternTable = Map<object, InternNode>;

type ScopedInterning = Readonly<{
  table: InternTable;
  parent?: ScopedInterning;
}>;

type ValueArena = Readonly<{
  values: StoredValue[];
  widthBounds: (WidthBounds | undefined)[];
  canonicalInterned: InternTable;
}>;

const scopedTable = Symbol("scopedValueTable");

type ScopedTable = Readonly<{
  [scopedTable]: true;
  arena: ValueArena;
  scopedInterning: ScopedInterning;
}>;

const noInputs: readonly ValueInput[] = [];
const noChildren: readonly ValueId[] = [];

export class ValueTable implements ValueBuilder {
  readonly #arena: ValueArena;
  readonly #scopedInterning: ScopedInterning;
  readonly #foldContext: ValueFoldContext = {
    constValue: (id) => this.constValue(id),
    integerValue: (id) => this.#integerValue(id),
    constant: (value) => this.const(value),
    unreachable: (type) => this.unreachable(type),
    widthBounds: (id) => this.widthBounds(id),
    extension: (id) => {
      const node = this.#entry(id).node;

      return node.kind === "extend" ? node : undefined;
    },
    truncate: (width, value) => this.truncate(width, value),
    eqz: (value) => this.unary("eqz", value)
  };

  constructor(scope?: ScopedTable) {
    this.#arena = scope?.arena ?? {
      values: [],
      widthBounds: [],
      canonicalInterned: new Map()
    };
    this.#scopedInterning = scope?.scopedInterning ?? { table: new Map() };
  }

  childScope(): ValueTable {
    return new ValueTable({
      [scopedTable]: true,
      arena: this.#arena,
      scopedInterning: {
        table: new Map(),
        parent: this.#scopedInterning
      }
    });
  }

  node(id: ValueId): ValueNode {
    return this.#entry(id).node;
  }

  size(): number {
    return this.#arena.values.length;
  }

  // Analysis forks preserve every existing ValueId while isolating all later
  // allocation and interning. Stored entries are immutable, so the prefix can
  // be shared safely; mutable caches and trie nodes are copied.
  fork(): ValueTable {
    return new ValueTable({
      [scopedTable]: true,
      arena: {
        values: [...this.#arena.values],
        widthBounds: [...this.#arena.widthBounds],
        canonicalInterned: cloneInternTable(this.#arena.canonicalInterned)
      },
      scopedInterning: cloneScopedInterning(this.#scopedInterning)
    });
  }

  // Preserves definition input order, which is eager evaluation order.
  children(id: ValueId): readonly ValueId[] {
    return this.#entry(id).children();
  }

  valueType(id: ValueId): ValueType {
    return this.#entry(id).resultType();
  }

  widthBounds(id: ValueId): WidthBounds {
    const existing = this.#arena.widthBounds[id];

    if (existing !== undefined) {
      return existing;
    }

    const derived = this.#entry(id).bounds(this.#foldContext);

    this.#arena.widthBounds[id] = derived;
    return derived;
  }

  mayTrap(id: ValueId): boolean {
    return this.#entry(id).mayTrap();
  }

  // Placement keeps guarded-away trap backstops in their valid region. This
  // transitive fact is placement-only: folding may discard those backstops.
  isNonTrapping(id: ValueId): boolean {
    return this.#entry(id).isNonTrapping();
  }

  isUnreachable(id: ValueId): boolean {
    return this.#entry(id).node.kind === "unreachable";
  }

  captureMode(id: ValueId): ValueCaptureMode {
    return this.#entry(id).captureMode();
  }

  // The node's compile-time i32 constant, when it is one.
  constValue(id: ValueId): number | undefined {
    return this.#entry(id).constValue();
  }

  const(value: number): ValueId {
    return this.#create(constantValue, { value });
  }

  const64(value: bigint): ValueId {
    return this.#create(constant64Value, { value });
  }

  unreachable(type: ValueType = "i32"): ValueId {
    return this.#create(unreachableValue, { type });
  }

  parameter(index: number, type: ValueType): ValueId {
    return this.#create(parameterValue, { index, type });
  }

  addNodeOutput(bounds?: WidthBounds): ValueId {
    return this.#create(nodeOutputValue, { type: "i32" }, bounds ?? unboundedWidthBounds);
  }

  // The 64 suffix is the i64 type universe; i64 values carry no i32 width
  // bounds, so the form takes none.
  addNodeOutput64(): ValueId {
    return this.#create(nodeOutputValue, { type: "i64" });
  }

  addLoopInput(bounds?: WidthBounds): ValueId {
    return this.#create(loopInputValue, undefined, bounds ?? unboundedWidthBounds);
  }

  binary(operator: BinaryOperator, a: ValueId, b: ValueId): ValueId {
    return this.#create(binaryValue, { type: "i32", operator, a, b });
  }

  binary64(operator: BinaryOperator, a: ValueId, b: ValueId): ValueId {
    return this.#create(binaryValue, { type: "i64", operator, a, b });
  }

  unary(operator: UnaryOperator, value: ValueId): ValueId {
    return this.#create(unaryValue, { operator, value });
  }

  // Compares in the width's domain: signed predicates sign-extend operands,
  // while unsigned/equality predicates mask them.
  compare(width: IntegerWidth, operator: CompareOperator, a: ValueId, b: ValueId): ValueId {
    const signed = compareIsSigned(operator);
    const left = this.widthAdjusted(width, a, signed);
    const right = this.widthAdjusted(width, b, signed);

    return this.#create(comparisonValue, {
      type: "i32",
      operator,
      a: left,
      b: right
    });
  }

  compare64(operator: CompareOperator, a: ValueId, b: ValueId): ValueId {
    return this.#create(comparisonValue, { type: "i64", operator, a, b });
  }

  select(condition: ValueId, whenTrue: ValueId, whenFalse: ValueId): ValueId {
    return this.#create(selectValue, { condition, whenTrue, whenFalse });
  }

  truncate(width: IntegerWidth, value: ValueId): ValueId {
    return this.#create(truncateValue, { inputType: "i32", width, value });
  }

  truncate64(width: IntegerWidth, value: ValueId): ValueId {
    return this.#create(truncateValue, { inputType: "i64", width, value });
  }

  extend(width: IntegerWidth, value: ValueId, signed: boolean): ValueId {
    return this.#create(extendValue, { resultType: "i32", width, value, signed });
  }

  // The value seen through a width-limited access: sign-extended when
  // signed, masked otherwise.
  widthAdjusted(width: IntegerWidth, value: ValueId, signed: boolean): ValueId {
    return signed ? this.extend(width, value, true) : this.truncate(width, value);
  }

  extend64(width: IntegerWidth, value: ValueId, signed: boolean): ValueId {
    return this.#create(extendValue, { resultType: "i64", width, value, signed });
  }

  #create<Args, Node extends ValueNode>(
    definition: ValueDefinition<Args, Node>,
    args: Args,
    initialBounds?: WidthBounds
  ): ValueId {
    const node = definition.create(args);
    const inputs = definition.inputs?.(node) ?? noInputs;

    this.#validateInputs(inputs);

    const folded = definition.fold?.(node, this.#foldContext);
    if (folded !== undefined) {
      return folded;
    }

    switch (definition.identity.kind) {
      case "occurrence":
        return this.#append(definition, node, inputs, initialBounds);
      case "canonical":
        return this.#intern(
          this.#arena.canonicalInterned,
          definition,
          node,
          inputs,
          definition.identity.key(node),
          initialBounds
        );
      case "scoped":
        return this.#internScoped(
          definition,
          node,
          inputs,
          definition.identity.key(node),
          initialBounds
        );
    }
  }

  #internScoped<Args, Node extends ValueNode>(
    definition: ValueDefinition<Args, Node>,
    node: Node,
    inputs: readonly ValueInput[],
    key: readonly ValueKey[],
    initialBounds: WidthBounds | undefined
  ): ValueId {
    for (
      let scope: ScopedInterning | undefined = this.#scopedInterning;
      scope !== undefined;
      scope = scope.parent
    ) {
      const existing = internedValue(scope.table, definition, key);

      if (existing !== undefined) {
        return existing;
      }
    }

    return this.#intern(
      this.#scopedInterning.table,
      definition,
      node,
      inputs,
      key,
      initialBounds
    );
  }

  #intern<Args, Node extends ValueNode>(
    table: InternTable,
    definition: ValueDefinition<Args, Node>,
    node: Node,
    inputs: readonly ValueInput[],
    key: readonly ValueKey[],
    initialBounds: WidthBounds | undefined
  ): ValueId {
    const existingRoot = table.get(definition);
    let position: InternNode;

    if (existingRoot === undefined) {
      position = internNode();
      table.set(definition, position);
    } else {
      position = existingRoot;
    }

    for (const part of key) {
      const existingChild = position.children.get(part);

      if (existingChild === undefined) {
        const child = internNode();

        position.children.set(part, child);
        position = child;
      } else {
        position = existingChild;
      }
    }

    if (position.value !== undefined) {
      return position.value;
    }

    const id = this.#append(definition, node, inputs, initialBounds);

    position.value = id;
    return id;
  }

  #append<Args, Node extends ValueNode>(
    definition: ValueDefinition<Args, Node>,
    node: Node,
    inputs: readonly ValueInput[],
    initialBounds: WidthBounds | undefined
  ): ValueId {
    const id = valueId(this.#arena.values.length);
    const mayTrap = definition.mayTrap?.(node, this.#foldContext) ?? false;
    const nonTrapping = !mayTrap && inputs.every((input) => this.isNonTrapping(input.value));

    this.#arena.values.push(new StoredValueEntry(
      definition,
      node,
      inputs,
      mayTrap,
      nonTrapping
    ));
    this.#arena.widthBounds.push(initialBounds);
    return id;
  }

  #entry(id: ValueId): StoredValue {
    const entry = this.#arena.values[id];

    assert(entry !== undefined, `unknown value id ${id}`);
    return entry;
  }

  #validateInputs(inputs: readonly ValueInput[]): void {
    for (const input of inputs) {
      const actual = this.valueType(input.value);
      assert(actual === input.type, `value ${input.value} must be ${input.type}, got ${actual}`);
    }
  }

  #integerValue(id: ValueId): bigint | undefined {
    return this.#entry(id).integerValue();
  }
}

function internNode(): InternNode {
  return { children: new Map(), value: undefined };
}

function cloneInternNode(source: InternNode): InternNode {
  return {
    children: new Map(
      [...source.children].map(([key, child]) => [key, cloneInternNode(child)])
    ),
    value: source.value
  };
}

function cloneInternTable(source: InternTable): InternTable {
  return new Map(
    [...source].map(([definition, root]) => [definition, cloneInternNode(root)])
  );
}

function cloneScopedInterning(source: ScopedInterning): ScopedInterning {
  return {
    table: cloneInternTable(source.table),
    ...(source.parent === undefined
      ? {}
      : { parent: cloneScopedInterning(source.parent) })
  };
}

function internedValue(
  table: InternTable,
  definition: object,
  key: readonly ValueKey[]
): ValueId | undefined {
  let position = table.get(definition);

  if (position === undefined) {
    return undefined;
  }
  for (const part of key) {
    position = position.children.get(part);
    if (position === undefined) {
      return undefined;
    }
  }
  return position.value;
}
