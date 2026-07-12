import type { ExternalValueId } from "./operands.js";
import type { BinaryOperator, CompareOperator, UnaryOperator } from "./operators.js";
import type { OperandWidth } from "#x86/types.js";

declare const valueBrand: unique symbol;

export type Value = number & { readonly [valueBrand]: "x86-semantic-value" };
export type ValueId = Value;

export interface Values {
  const(value: number): ValueId;
  const64(value: bigint): ValueId;
  binary(operator: BinaryOperator, a: ValueId, b: ValueId): ValueId;
  unary(operator: UnaryOperator, value: ValueId): ValueId;
  select(condition: ValueId, whenTrue: ValueId, whenFalse: ValueId): ValueId;
  truncate(width: OperandWidth, value: ValueId): ValueId;
  extend(width: OperandWidth, value: ValueId, signed: boolean): ValueId;
  compare(width: OperandWidth, operator: CompareOperator, a: ValueId, b: ValueId): ValueId;
  binary64(operator: BinaryOperator, a: ValueId, b: ValueId): ValueId;
  compare64(operator: CompareOperator, a: ValueId, b: ValueId): ValueId;
  truncate64(width: OperandWidth, value: ValueId): ValueId;
  extend64(width: OperandWidth, value: ValueId, signed: boolean): ValueId;
}

export function valueId(id: number): ValueId {
  return id as ValueId;
}

export type ValueType = "i32" | "i64";

// Nodes reference children by ValueId only; there is no nested-tree form.
// Actions are not expressions: a scheduled op output enters the
// graph as an actionOutput leaf.
export type ConstValueNode = Readonly<{ kind: "const"; value: number }>;
export type Const64ValueNode = Readonly<{ kind: "const64"; value: bigint }>;
export type UnreachableValueNode = Readonly<{ kind: "unreachable"; type: ValueType }>;
export type ActionOutputValueNode = Readonly<{ kind: "actionOutput" }>;
// A loop-carried cell's iteration-start value; the emitter binds it to the
// cell's local. Opaque and never interned, like actionOutput.
export type LoopInputValueNode = Readonly<{ kind: "loopInput" }>;
export type ExternalValueNode = Readonly<{ kind: "external"; external: ExternalValueId }>;
export type BinaryValueNode = Readonly<{
  kind: "binary";
  type: ValueType;
  operator: BinaryOperator;
  a: ValueId;
  b: ValueId;
}>;
export type UnaryValueNode = Readonly<{ kind: "unary"; operator: UnaryOperator; value: ValueId }>;
export type CompareValueNode = Readonly<{
  kind: "compare";
  type: ValueType;
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
export type TruncateValueNode = Readonly<{
  kind: "truncate";
  sourceType: ValueType;
  width: OperandWidth;
  value: ValueId;
}>;
export type ExtendValueNode = Readonly<{
  kind: "extend";
  type: ValueType;
  signed: boolean;
  width: OperandWidth;
  value: ValueId;
}>;

export type ValueNode =
  | ConstValueNode
  | Const64ValueNode
  | UnreachableValueNode
  | ActionOutputValueNode
  | LoopInputValueNode
  | ExternalValueNode
  | BinaryValueNode
  | UnaryValueNode
  | CompareValueNode
  | SelectValueNode
  | TruncateValueNode
  | ExtendValueNode;

export function valueChildren(node: ValueNode): readonly ValueId[] {
  switch (node.kind) {
    case "const":
    case "const64":
    case "actionOutput":
    case "loopInput":
    case "external":
    case "unreachable":
      return [];
    case "binary":
    case "compare":
      return [node.a, node.b];
    case "unary":
    case "extend":
    case "truncate":
      return [node.value];
    case "select":
      return [node.condition, node.whenTrue, node.whenFalse];
  }
}

// What is provably known about a node's value: the smallest width it fits
// unsigned (all higher bits zero) and the smallest width it equals its own
// sign-extension from. 32 in either bound means no information — every i32
// trivially satisfies both at 32.
export type WidthBounds = Readonly<{ unsignedBits: number; signedBits: number }>;

export const unboundedWidthBounds: WidthBounds = { unsignedBits: 32, signedBits: 32 };

export function joinWidthBounds(bounds: Iterable<WidthBounds>): WidthBounds {
  let joined: WidthBounds | undefined;

  for (const bound of bounds) {
    joined = joined === undefined
      ? bound
      : {
          unsignedBits: Math.max(joined.unsignedBits, bound.unsignedBits),
          signedBits: Math.max(joined.signedBits, bound.signedBits)
        };
  }

  return joined ?? unboundedWidthBounds;
}

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
