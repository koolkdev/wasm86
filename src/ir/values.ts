import { assert } from "#common/assert.js";
import {
  get2,
  get3,
  put2,
  put3,
  type Map2,
  type Map3
} from "#common/nested-map.js";
import type { BinaryOperator, CompareOperator, UnaryOperator } from "#x86/semantics/ops.js";
import { i32 } from "#x86/numeric.js";
import type { OperandWidth } from "#x86/types.js";
import type { ExternalValueId } from "./operands.js";

export type ValueId = number;

// Nodes reference children by ValueId only; there is no nested-tree form.
// Actions are not expressions: a readState/readMemory output enters the
// graph as an actionOutput leaf.
export type ConstValueNode = Readonly<{ kind: "const"; value: number }>;
export type ActionOutputValueNode = Readonly<{ kind: "actionOutput" }>;
export type ExternalValueNode = Readonly<{ kind: "external"; external: ExternalValueId }>;
export type BinaryValueNode = Readonly<{
  kind: "binary";
  operator: BinaryOperator;
  a: ValueId;
  b: ValueId;
}>;
export type UnaryValueNode = Readonly<{ kind: "unary"; operator: UnaryOperator; value: ValueId }>;
export type CompareValueNode = Readonly<{
  kind: "compare";
  operator: CompareOperator;
  a: ValueId;
  b: ValueId;
}>;
export type SelectValueNode = Readonly<{
  kind: "select";
  condition: ValueId;
  whenTrue: ValueId;
  whenFalse: ValueId;
}>;
export type ProjectValueNode = Readonly<{ kind: "project"; width: OperandWidth; value: ValueId }>;

export type ValueNode =
  | ConstValueNode
  | ActionOutputValueNode
  | ExternalValueNode
  | BinaryValueNode
  | UnaryValueNode
  | CompareValueNode
  | SelectValueNode
  | ProjectValueNode;

// What is provably known about a node's value: the smallest width it fits
// unsigned (all higher bits zero) and the smallest width it equals its own
// sign-extension from. 32 in either bound means no information — every i32
// trivially satisfies both at 32.
export type WidthBounds = Readonly<{ unsignedBits: number; signedBits: number }>;

const unbounded: WidthBounds = { unsignedBits: 32, signedBits: 32 };

export function fitsUnsigned(bits: number): WidthBounds {
  return clampedBounds(bits, 32);
}

export function signExtended(bits: number): WidthBounds {
  return clampedBounds(32, bits);
}

function clampedBounds(unsignedBits: number, signedBits: number): WidthBounds {
  return {
    unsignedBits,
    // Fitting unsigned in w implies sign extension from w + 1.
    signedBits: Math.min(signedBits, unsignedBits + 1, 32)
  };
}

export class ValueTable {
  readonly #nodes: ValueNode[] = [];
  // Derived on first query, memoized per node.
  readonly #widthBounds: (WidthBounds | undefined)[] = [];
  readonly #constIds = new Map<number, ValueId>();
  readonly #externalIds = new Map<ExternalValueId, ValueId>();
  readonly #binaryIds: Map3<BinaryOperator, ValueId, ValueId, ValueId> = new Map();
  readonly #unaryIds: Map2<UnaryOperator, ValueId, ValueId> = new Map();
  readonly #compareIds: Map3<CompareOperator, ValueId, ValueId, ValueId> = new Map();
  readonly #selectIds: Map3<ValueId, ValueId, ValueId, ValueId> = new Map();
  readonly #projectIds: Map2<OperandWidth, ValueId, ValueId> = new Map();

  #add(node: ValueNode, children: readonly ValueId[]): ValueId {
    for (const child of children) {
      assert(this.#nodes[child] !== undefined, `unknown value id ${child}`);
    }

    const id = this.#nodes.length;

    this.#nodes.push(Object.freeze(node));
    this.#widthBounds.push(undefined);

    return id;
  }

  node(id: ValueId): ValueNode {
    const found = this.#nodes[id];

    assert(found !== undefined, `unknown value id ${id}`);
    return found;
  }

  #widthBoundsOf(id: ValueId): WidthBounds {
    const existing = this.#widthBounds[id];

    if (existing !== undefined) {
      return existing;
    }

    const derived = ValueTable.#deriveWidthBounds(this.node(id), (child) => this.#widthBoundsOf(child));

    this.#widthBounds[id] = derived;
    return derived;
  }

  internConst(value: number): ValueId {
    const canonical = i32(value);
    const existing = this.#constIds.get(canonical);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "const", value: canonical }, []);

    this.#constIds.set(canonical, id);
    return id;
  }

  internExternal(external: ExternalValueId): ValueId {
    const existing = this.#externalIds.get(external);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "external", external }, []);

    this.#externalIds.set(external, id);
    return id;
  }

  addActionOutput(bounds?: WidthBounds): ValueId {
    // Each action produces a distinct value; outputs are never deduped.
    const id = this.#add({ kind: "actionOutput" }, []);

    this.#widthBounds[id] = bounds ?? unbounded;
    return id;
  }

  internBinary(operator: BinaryOperator, a: ValueId, b: ValueId): ValueId {
    const existing = get3(this.#binaryIds, operator, a, b);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "binary", operator, a, b }, [a, b]);

    put3(this.#binaryIds, operator, a, b, id);
    return id;
  }

  internUnary(operator: UnaryOperator, value: ValueId): ValueId {
    const existing = get2(this.#unaryIds, operator, value);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "unary", operator, value }, [value]);

    put2(this.#unaryIds, operator, value, id);
    return id;
  }

  internCompare(operator: CompareOperator, a: ValueId, b: ValueId): ValueId {
    const existing = get3(this.#compareIds, operator, a, b);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "compare", operator, a, b }, [a, b]);

    put3(this.#compareIds, operator, a, b, id);
    return id;
  }

  internSelect(condition: ValueId, whenTrue: ValueId, whenFalse: ValueId): ValueId {
    const existing = get3(this.#selectIds, condition, whenTrue, whenFalse);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "select", condition, whenTrue, whenFalse }, [
      condition,
      whenTrue,
      whenFalse
    ]);

    put3(this.#selectIds, condition, whenTrue, whenFalse, id);
    return id;
  }

  internProject(width: OperandWidth, value: ValueId): ValueId {
    const existing = get2(this.#projectIds, width, value);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "project", width, value }, [value]);

    put2(this.#projectIds, width, value, id);
    return id;
  }

  // Smart constructor: the interned projection, or the value itself when its
  // width bounds already cover the request.
  projectTo(width: OperandWidth, value: ValueId): ValueId {
    const found = this.node(value);

    if (found.kind === "const") {
      return this.internConst(ValueTable.#projectConst(width, found.value));
    }

    if (width === 32 || this.#widthBoundsOf(value).unsignedBits <= width) {
      return value;
    }

    return this.internProject(width, value);
  }

  // Smart constructor: the interned extension, or the value itself when its
  // width bounds already cover the request.
  extendTo(width: OperandWidth, value: ValueId): ValueId {
    const found = this.node(value);

    if (found.kind === "const") {
      return this.internConst(ValueTable.#extendConst(width, found.value));
    }

    if (width === 32 || this.#widthBoundsOf(value).signedBits <= width) {
      return value;
    }

    return this.internUnary(width === 8 ? "extend8_s" : "extend16_s", value);
  }

  // The node's compile-time constant, when it is one; i32-canonical.
  constValue(id: ValueId): number | undefined {
    const found = this.node(id);

    return found.kind === "const" ? found.value : undefined;
  }

  size(): number {
    return this.#nodes.length;
  }

  static #deriveWidthBounds(
    node: ValueNode,
    widthBoundsOf: (id: ValueId) => WidthBounds
  ): WidthBounds {
    switch (node.kind) {
      case "const":
        return ValueTable.#constWidthBounds(node.value);
      case "actionOutput":
      case "external":
        // Action outputs carry their bounds from creation; externals are opaque.
        return unbounded;
      case "binary":
        return ValueTable.#binaryWidthBounds(node, widthBoundsOf);
      case "select":
        return ValueTable.#selectWidthBounds(node, widthBoundsOf);
      case "unary":
        return ValueTable.#unaryWidthBounds(node, widthBoundsOf);
      case "compare":
        return fitsUnsigned(1);
      case "project":
        return fitsUnsigned(Math.min(node.width, widthBoundsOf(node.value).unsignedBits));
    }
  }

  static #projectConst(width: OperandWidth, value: number): number {
    switch (width) {
      case 8:
        return value & 0xff;
      case 16:
        return value & 0xffff;
      case 32:
        return i32(value);
    }
  }

  static #extendConst(width: OperandWidth, value: number): number {
    switch (width) {
      case 8:
        return (value << 24) >> 24;
      case 16:
        return (value << 16) >> 16;
      case 32:
        return i32(value);
    }
  }

  static #binaryWidthBounds(
    node: BinaryValueNode,
    widthBoundsOf: (id: ValueId) => WidthBounds
  ): WidthBounds {
    const a = widthBoundsOf(node.a);
    const b = widthBoundsOf(node.b);
    // Bitwise ops preserve sign extension: when the bits from position w - 1 up
    // are sign-bit copies in both operands, they still are in the result.
    const bitwiseSignedBits = Math.max(a.signedBits, b.signedBits);

    switch (node.operator) {
      case "and":
        // Can only clear bits: the tighter operand bounds the result.
        return clampedBounds(Math.min(a.unsignedBits, b.unsignedBits), bitwiseSignedBits);
      case "or":
      case "xor":
        // Cannot set a bit above either operand's bound.
        return clampedBounds(Math.max(a.unsignedBits, b.unsignedBits), bitwiseSignedBits);
      case "shr_u":
        // A logical right shift never increases the value.
        return clampedBounds(a.unsignedBits, 32);
      case "add":
      case "sub":
      case "shl":
        // Wrapping arithmetic has no cheap bound.
        return unbounded;
    }
  }

  static #selectWidthBounds(
    node: SelectValueNode,
    widthBoundsOf: (id: ValueId) => WidthBounds
  ): WidthBounds {
    // The result is one of the two arms, so the weaker arm bound holds.
    const whenTrue = widthBoundsOf(node.whenTrue);
    const whenFalse = widthBoundsOf(node.whenFalse);

    return clampedBounds(
      Math.max(whenTrue.unsignedBits, whenFalse.unsignedBits),
      Math.max(whenTrue.signedBits, whenFalse.signedBits)
    );
  }

  static #unaryWidthBounds(
    node: UnaryValueNode,
    widthBoundsOf: (id: ValueId) => WidthBounds
  ): WidthBounds {
    switch (node.operator) {
      case "extend8_s":
        return signExtended(Math.min(8, widthBoundsOf(node.value).signedBits));
      case "extend16_s":
        return signExtended(Math.min(16, widthBoundsOf(node.value).signedBits));
      case "popcnt":
        return unbounded;
    }
  }

  static #constWidthBounds(value: number): WidthBounds {
    return {
      // Position of the highest set bit; negative values use the sign bit.
      unsignedBits: value < 0 ? 32 : Math.max(1, 32 - Math.clz32(value)),
      // Significant bits plus the sign bit.
      signedBits: Math.min(32, 33 - Math.clz32(value ^ (value >> 31)))
    };
  }
}
