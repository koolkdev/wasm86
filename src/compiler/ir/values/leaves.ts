import { assert } from "#common/assert.js";
import { i32 } from "#common/numeric.js";
import type { ValueDefinition } from "./definition.js";
import type { ValueType, WidthBounds } from "./types.js";
import { unboundedWidthBounds } from "./width-bounds.js";

type ConstArgs = Readonly<{ value: number }>;
type ConstNode = Readonly<ConstArgs & { kind: "const" }>;

type Const64Args = Readonly<{ value: bigint }>;
type Const64Node = Readonly<Const64Args & { kind: "const64" }>;

type UnreachableArgs = Readonly<{ type: ValueType }>;
type UnreachableNode = Readonly<UnreachableArgs & { kind: "unreachable" }>;

type NodeOutputArgs = Readonly<{ type: ValueType }>;
type NodeOutputNode = Readonly<NodeOutputArgs & { kind: "nodeOutput" }>;
type LoopInputNode = Readonly<{ kind: "loopInput" }>;

type ParameterArgs = Readonly<{ index: number; type: ValueType }>;
type ParameterNode = Readonly<ParameterArgs & { kind: "parameter" }>;

export const constantValue: ValueDefinition<ConstArgs, ConstNode> = {
  create: ({ value }) => ({ kind: "const", value: i32(value) }),
  identity: { kind: "canonical", key: (node) => [node.value] },
  resultType: () => "i32",
  widthBounds: (node) => constWidthBounds(node.value),
  captureMode: "reemit",
  constValue: (node) => node.value,
  integerValue: (node) => BigInt(node.value),
  emit: (_id, node, target) => target.body.i32Const(node.value)
};

export const constant64Value: ValueDefinition<Const64Args, Const64Node> = {
  create: ({ value }) => ({ kind: "const64", value: BigInt.asIntN(64, value) }),
  identity: { kind: "canonical", key: (node) => [node.value] },
  resultType: () => "i64",
  widthBounds: () => {
    assert(false, "width bounds requested for i64 constant value");
  },
  captureMode: "reemit",
  integerValue: (node) => node.value,
  emit: (_id, node, target) => target.body.i64Const(node.value)
};

export const unreachableValue: ValueDefinition<UnreachableArgs, UnreachableNode> = {
  create: ({ type }) => ({ kind: "unreachable", type }),
  identity: { kind: "canonical", key: (node) => [node.type] },
  resultType: (node) => node.type,
  widthBounds: () => unboundedWidthBounds,
  mayTrap: () => true,
  captureMode: "reemit",
  emit: (_id, _node, target) => target.body.unreachable()
};

export const nodeOutputValue: ValueDefinition<NodeOutputArgs, NodeOutputNode> = {
  create: ({ type }) => ({ kind: "nodeOutput", type }),
  identity: { kind: "occurrence" },
  resultType: (node) => node.type,
  widthBounds: (node) => {
    assert(node.type === "i32", "width bounds requested for i64 node output");
    return unboundedWidthBounds;
  },
  captureMode: "producer",
  emit: (id, _node, target) => target.emitNodeOutput(id)
};

export const loopInputValue: ValueDefinition<undefined, LoopInputNode> = {
  create: () => ({ kind: "loopInput" }),
  identity: { kind: "occurrence" },
  resultType: () => "i32",
  widthBounds: () => unboundedWidthBounds,
  captureMode: "reemit",
  emit: (id, _node, target) => target.emitLoopInput(id)
};

export const parameterValue: ValueDefinition<ParameterArgs, ParameterNode> = {
  create: ({ index, type }) => {
    assert(Number.isInteger(index) && index >= 0, `invalid function parameter index: ${index}`);
    return { kind: "parameter", index, type };
  },
  identity: { kind: "canonical", key: (node) => [node.index, node.type] },
  resultType: (node) => node.type,
  widthBounds: (node) => {
    assert(node.type === "i32", "width bounds requested for i64 parameter");
    return unboundedWidthBounds;
  },
  captureMode: "reemit",
  emit: (_id, node, target) => target.emitParameter(node.index)
};

function constWidthBounds(value: number): WidthBounds {
  return {
    // Position of the highest set bit; negative values use the sign bit.
    unsignedBits: value < 0 ? 32 : Math.max(1, 32 - Math.clz32(value)),
    // Significant bits plus the sign bit.
    signedBits: Math.min(32, 33 - Math.clz32(value ^ (value >> 31)))
  };
}
