import { assert } from "#common/assert.js";
import { i32 } from "#core/numeric.js";
import type { ExternalValueId } from "#ir/operands.js";
import type { ValueDefinition } from "./definition.js";
import type { ValueType, WidthBounds } from "./types.js";
import { unboundedWidthBounds } from "./width-bounds.js";

type ConstArgs = Readonly<{ value: number }>;
type ConstNode = Readonly<ConstArgs & { kind: "const" }>;

type Const64Args = Readonly<{ value: bigint }>;
type Const64Node = Readonly<Const64Args & { kind: "const64" }>;

type UnreachableArgs = Readonly<{ type: ValueType }>;
type UnreachableNode = Readonly<UnreachableArgs & { kind: "unreachable" }>;

type ActionOutputNode = Readonly<{ kind: "actionOutput" }>;
type LoopInputNode = Readonly<{ kind: "loopInput" }>;

type ExternalArgs = Readonly<{ external: ExternalValueId }>;
type ExternalNode = Readonly<ExternalArgs & { kind: "external" }>;

export const constantValue: ValueDefinition<ConstArgs, ConstNode> = {
  create: ({ value }) => ({ kind: "const", value: i32(value) }),
  internKey: (node) => [node.value],
  resultType: () => "i32",
  widthBounds: (node) => constWidthBounds(node.value),
  captureMode: "reemit",
  constValue: (node) => node.value,
  integerValue: (node) => BigInt(node.value),
  emit: (_id, node, target) => target.body.i32Const(node.value)
};

export const constant64Value: ValueDefinition<Const64Args, Const64Node> = {
  create: ({ value }) => ({ kind: "const64", value: BigInt.asIntN(64, value) }),
  internKey: (node) => [node.value],
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
  internKey: (node) => [node.type],
  resultType: (node) => node.type,
  widthBounds: () => unboundedWidthBounds,
  mayTrap: () => true,
  captureMode: "reemit",
  emit: (_id, _node, target) => target.body.unreachable()
};

export const actionOutputValue: ValueDefinition<undefined, ActionOutputNode> = {
  create: () => ({ kind: "actionOutput" }),
  internKey: () => undefined,
  resultType: () => "i32",
  widthBounds: () => unboundedWidthBounds,
  captureMode: "producer",
  emit: (id, _node, target) => target.emitActionOutput(id)
};

export const loopInputValue: ValueDefinition<undefined, LoopInputNode> = {
  create: () => ({ kind: "loopInput" }),
  internKey: () => undefined,
  resultType: () => "i32",
  widthBounds: () => unboundedWidthBounds,
  captureMode: "reemit",
  emit: (id, _node, target) => target.emitLoopInput(id)
};

export const externalValue: ValueDefinition<ExternalArgs, ExternalNode> = {
  create: ({ external }) => ({ kind: "external", external }),
  internKey: (node) => [node.external],
  resultType: () => "i32",
  widthBounds: () => unboundedWidthBounds,
  captureMode: "reemit",
  emit: (_id, node, target) => target.emitExternal(node.external)
};

function constWidthBounds(value: number): WidthBounds {
  return {
    // Position of the highest set bit; negative values use the sign bit.
    unsignedBits: value < 0 ? 32 : Math.max(1, 32 - Math.clz32(value)),
    // Significant bits plus the sign bit.
    signedBits: Math.min(32, 33 - Math.clz32(value ^ (value >> 31)))
  };
}
