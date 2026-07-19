import { assert } from "#common/assert.js";
import type { OperandWidth } from "#core/types.js";
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
  type ValueEmitContext,
  type ValueFoldContext,
  type ValueKey
} from "./definition.js";
import {
  actionOutputValue,
  constant64Value,
  constantValue,
  externalValue,
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
  type ExternalValueId,
  type ValueId,
  type ValueInput,
  type ValueType,
  type WidthBounds
} from "./types.js";
import { unboundedWidthBounds } from "./width-bounds.js";

type AnyValueDefinition =
  | typeof actionOutputValue
  | typeof binaryValue
  | typeof comparisonValue
  | typeof constant64Value
  | typeof constantValue
  | typeof extendValue
  | typeof externalValue
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
  emit(id: ValueId, context: ValueEmitContext): void;
}

class StoredValueEntry<Args, Node extends ValueNode> implements StoredValue {
  readonly #inputs: readonly ValueInput[];
  readonly #children: readonly ValueId[];

  constructor(
    private readonly definition: ValueDefinition<Args, Node>,
    readonly node: Node,
    inputs: readonly ValueInput[],
    private readonly intrinsicMayTrap: boolean,
    private readonly nonTrapping: boolean
  ) {
    this.#inputs = inputs;
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

  emit(id: ValueId, context: ValueEmitContext): void {
    for (const input of this.#inputs) {
      context.emitUse(input.value);
    }

    this.definition.emit(id, this.node, context);
  }
}

type InternNode = {
  readonly children: Map<ValueKey, InternNode>;
  value: ValueId | undefined;
};

const noInputs: readonly ValueInput[] = [];
const noChildren: readonly ValueId[] = [];

export class ValueTable implements ValueBuilder {
  readonly #values: StoredValue[] = [];
  readonly #widthBounds: (WidthBounds | undefined)[] = [];
  readonly #interned = new Map<object, InternNode>();
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

  node(id: ValueId): ValueNode {
    return this.#entry(id).node;
  }

  size(): number {
    return this.#values.length;
  }

  // Analysis forks preserve every existing ValueId while isolating all later
  // allocation and interning. Stored entries are immutable, so the prefix can
  // be shared safely; mutable caches and trie nodes are copied.
  fork(): ValueTable {
    const fork = new ValueTable();

    fork.#values.push(...this.#values);
    fork.#widthBounds.push(...this.#widthBounds);
    for (const [definition, root] of this.#interned) {
      fork.#interned.set(definition, cloneInternNode(root));
    }
    return fork;
  }

  children(id: ValueId): readonly ValueId[] {
    return this.#entry(id).children();
  }

  valueType(id: ValueId): ValueType {
    return this.#entry(id).resultType();
  }

  widthBounds(id: ValueId): WidthBounds {
    const existing = this.#widthBounds[id];

    if (existing !== undefined) {
      return existing;
    }

    const derived = this.#entry(id).bounds(this.#foldContext);

    this.#widthBounds[id] = derived;
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

  emit(id: ValueId, context: ValueEmitContext): void {
    this.#entry(id).emit(id, context);
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

  external(external: ExternalValueId): ValueId {
    return this.#create(externalValue, { external });
  }

  parameter(index: number, type: ValueType): ValueId {
    return this.#create(parameterValue, { index, type });
  }

  addActionOutput(bounds?: WidthBounds): ValueId {
    return this.#create(actionOutputValue, { type: "i32" }, bounds ?? unboundedWidthBounds);
  }

  // The 64 suffix is the i64 type universe; i64 values carry no i32 width
  // bounds, so the form takes none.
  addActionOutput64(): ValueId {
    return this.#create(actionOutputValue, { type: "i64" });
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
  compare(width: OperandWidth, operator: CompareOperator, a: ValueId, b: ValueId): ValueId {
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

  truncate(width: OperandWidth, value: ValueId): ValueId {
    return this.#create(truncateValue, { inputType: "i32", width, value });
  }

  truncate64(width: OperandWidth, value: ValueId): ValueId {
    return this.#create(truncateValue, { inputType: "i64", width, value });
  }

  extend(width: OperandWidth, value: ValueId, signed: boolean): ValueId {
    return this.#create(extendValue, { resultType: "i32", width, value, signed });
  }

  // The value seen through a width-limited access: sign-extended when
  // signed, masked otherwise.
  widthAdjusted(width: OperandWidth, value: ValueId, signed: boolean): ValueId {
    return signed ? this.extend(width, value, true) : this.truncate(width, value);
  }

  extend64(width: OperandWidth, value: ValueId, signed: boolean): ValueId {
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

    const key = definition.internKey(node);
    if (key === undefined) {
      return this.#append(definition, node, inputs, initialBounds);
    }

    const existingRoot = this.#interned.get(definition);
    let position: InternNode;

    if (existingRoot === undefined) {
      position = internNode();
      this.#interned.set(definition, position);
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
    const id = valueId(this.#values.length);
    const mayTrap = definition.mayTrap?.(node, this.#foldContext) ?? false;
    const nonTrapping = !mayTrap && inputs.every((input) => this.isNonTrapping(input.value));

    this.#values.push(new StoredValueEntry(
      definition,
      node,
      inputs,
      mayTrap,
      nonTrapping
    ));
    this.#widthBounds.push(initialBounds);
    return id;
  }

  #entry(id: ValueId): StoredValue {
    const entry = this.#values[id];

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
