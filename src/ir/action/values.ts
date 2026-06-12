import { assert } from "#common/assert.js";
import {
  get2,
  get3,
  put2,
  put3,
  type Map2,
  type Map3
} from "#common/nested-map.js";
import type { IrBinaryOperator, IrCompareOperator, IrUnaryOperator } from "#ir/model/types.js";
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
  operator: IrBinaryOperator;
  a: ValueId;
  b: ValueId;
}>;
export type UnaryValueNode = Readonly<{ kind: "unary"; operator: IrUnaryOperator; value: ValueId }>;
export type CompareValueNode = Readonly<{
  kind: "compare";
  operator: IrCompareOperator;
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

export type ValueTable = Readonly<{
  internConst(value: number): ValueId;
  internExternal(external: ExternalValueId): ValueId;
  addActionOutput(bounds?: WidthBounds): ValueId;
  internBinary(operator: IrBinaryOperator, a: ValueId, b: ValueId): ValueId;
  internUnary(operator: IrUnaryOperator, value: ValueId): ValueId;
  internCompare(operator: IrCompareOperator, a: ValueId, b: ValueId): ValueId;
  internSelect(condition: ValueId, whenTrue: ValueId, whenFalse: ValueId): ValueId;
  internProject(width: OperandWidth, value: ValueId): ValueId;
  // Smart constructors: the interned projection/extension, or the value
  // itself when its width bounds already cover the request.
  projectTo(width: OperandWidth, value: ValueId): ValueId;
  extendTo(width: OperandWidth, value: ValueId): ValueId;
  node(id: ValueId): ValueNode;
  // The node's compile-time constant, when it is one; i32-canonical.
  constValue(id: ValueId): number | undefined;
  // References from other nodes in this table; action and region uses are
  // the consumer's to count.
  useCount(id: ValueId): number;
  size(): number;
}>;

export function createValueTable(): ValueTable {
  const nodes: ValueNode[] = [];
  const useCounts: number[] = [];
  // Derived on first query, memoized per node.
  const widthBounds: (WidthBounds | undefined)[] = [];
  const constIds = new Map<number, ValueId>();
  const externalIds = new Map<ExternalValueId, ValueId>();
  const binaryIds: Map3<IrBinaryOperator, ValueId, ValueId, ValueId> = new Map();
  const unaryIds: Map2<IrUnaryOperator, ValueId, ValueId> = new Map();
  const compareIds: Map3<IrCompareOperator, ValueId, ValueId, ValueId> = new Map();
  const selectIds: Map3<ValueId, ValueId, ValueId, ValueId> = new Map();
  const projectIds: Map2<OperandWidth, ValueId, ValueId> = new Map();

  function add(node: ValueNode, children: readonly ValueId[]): ValueId {
    for (const child of children) {
      assert(nodes[child] !== undefined, `unknown value id ${child}`);
    }

    const id = nodes.length;

    nodes.push(Object.freeze(node));
    useCounts.push(0);
    widthBounds.push(undefined);

    for (const child of children) {
      useCounts[child]! += 1;
    }

    return id;
  }

  function node(id: ValueId): ValueNode {
    const found = nodes[id];

    assert(found !== undefined, `unknown value id ${id}`);
    return found;
  }

  function widthBoundsOf(id: ValueId): WidthBounds {
    const existing = widthBounds[id];

    if (existing !== undefined) {
      return existing;
    }

    const derived = deriveWidthBounds(node(id), widthBoundsOf);

    widthBounds[id] = derived;
    return derived;
  }

  function internConst(value: number): ValueId {
    const canonical = i32(value);
    const existing = constIds.get(canonical);

    if (existing !== undefined) {
      return existing;
    }

    const id = add({ kind: "const", value: canonical }, []);

    constIds.set(canonical, id);
    return id;
  }

  function internExternal(external: ExternalValueId): ValueId {
    const existing = externalIds.get(external);

    if (existing !== undefined) {
      return existing;
    }

    const id = add({ kind: "external", external }, []);

    externalIds.set(external, id);
    return id;
  }

  function addActionOutput(bounds?: WidthBounds): ValueId {
    // Each action produces a distinct value; outputs are never deduped.
    const id = add({ kind: "actionOutput" }, []);

    widthBounds[id] = bounds ?? unbounded;
    return id;
  }

  function internBinary(operator: IrBinaryOperator, a: ValueId, b: ValueId): ValueId {
    const existing = get3(binaryIds, operator, a, b);

    if (existing !== undefined) {
      return existing;
    }

    const id = add({ kind: "binary", operator, a, b }, [a, b]);

    put3(binaryIds, operator, a, b, id);
    return id;
  }

  function internUnary(operator: IrUnaryOperator, value: ValueId): ValueId {
    const existing = get2(unaryIds, operator, value);

    if (existing !== undefined) {
      return existing;
    }

    const id = add({ kind: "unary", operator, value }, [value]);

    put2(unaryIds, operator, value, id);
    return id;
  }

  function internCompare(operator: IrCompareOperator, a: ValueId, b: ValueId): ValueId {
    const existing = get3(compareIds, operator, a, b);

    if (existing !== undefined) {
      return existing;
    }

    const id = add({ kind: "compare", operator, a, b }, [a, b]);

    put3(compareIds, operator, a, b, id);
    return id;
  }

  function internSelect(condition: ValueId, whenTrue: ValueId, whenFalse: ValueId): ValueId {
    const existing = get3(selectIds, condition, whenTrue, whenFalse);

    if (existing !== undefined) {
      return existing;
    }

    const id = add({ kind: "select", condition, whenTrue, whenFalse }, [
      condition,
      whenTrue,
      whenFalse
    ]);

    put3(selectIds, condition, whenTrue, whenFalse, id);
    return id;
  }

  function internProject(width: OperandWidth, value: ValueId): ValueId {
    const existing = get2(projectIds, width, value);

    if (existing !== undefined) {
      return existing;
    }

    const id = add({ kind: "project", width, value }, [value]);

    put2(projectIds, width, value, id);
    return id;
  }

  function projectTo(width: OperandWidth, value: ValueId): ValueId {
    if (width === 32 || widthBoundsOf(value).unsignedBits <= width) {
      return value;
    }

    return internProject(width, value);
  }

  function extendTo(width: OperandWidth, value: ValueId): ValueId {
    if (width === 32 || widthBoundsOf(value).signedBits <= width) {
      return value;
    }

    return internUnary(width === 8 ? "extend8_s" : "extend16_s", value);
  }

  return {
    internConst,
    internExternal,
    addActionOutput,
    internBinary,
    internUnary,
    internCompare,
    internSelect,
    internProject,
    projectTo,
    extendTo,
    node,
    constValue(id: ValueId): number | undefined {
      const found = node(id);

      return found.kind === "const" ? found.value : undefined;
    },
    useCount(id: ValueId): number {
      node(id);
      return useCounts[id]!;
    },
    size(): number {
      return nodes.length;
    }
  };
}

function deriveWidthBounds(node: ValueNode, widthBoundsOf: (id: ValueId) => WidthBounds): WidthBounds {
  switch (node.kind) {
    case "const":
      return constWidthBounds(node.value);
    case "actionOutput":
    case "external":
      // Action outputs carry their bounds from creation; externals are opaque.
      return unbounded;
    case "binary":
      return binaryWidthBounds(node, widthBoundsOf);
    case "select":
      return selectWidthBounds(node, widthBoundsOf);
    case "unary":
      return unaryWidthBounds(node, widthBoundsOf);
    case "compare":
      return fitsUnsigned(1);
    case "project":
      return fitsUnsigned(Math.min(node.width, widthBoundsOf(node.value).unsignedBits));
  }
}

function binaryWidthBounds(node: BinaryValueNode, widthBoundsOf: (id: ValueId) => WidthBounds): WidthBounds {
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

function selectWidthBounds(node: SelectValueNode, widthBoundsOf: (id: ValueId) => WidthBounds): WidthBounds {
  // The result is one of the two arms, so the weaker arm bound holds.
  const whenTrue = widthBoundsOf(node.whenTrue);
  const whenFalse = widthBoundsOf(node.whenFalse);

  return clampedBounds(
    Math.max(whenTrue.unsignedBits, whenFalse.unsignedBits),
    Math.max(whenTrue.signedBits, whenFalse.signedBits)
  );
}

function unaryWidthBounds(node: UnaryValueNode, widthBoundsOf: (id: ValueId) => WidthBounds): WidthBounds {
  switch (node.operator) {
    case "extend8_s":
      return signExtended(Math.min(8, widthBoundsOf(node.value).signedBits));
    case "extend16_s":
      return signExtended(Math.min(16, widthBoundsOf(node.value).signedBits));
    case "popcnt":
      return unbounded;
  }
}

function constWidthBounds(value: number): WidthBounds {
  return {
    // Position of the highest set bit; negative values use the sign bit.
    unsignedBits: value < 0 ? 32 : Math.max(1, 32 - Math.clz32(value)),
    // Significant bits plus the sign bit.
    signedBits: Math.min(32, 33 - Math.clz32(value ^ (value >> 31)))
  };
}
