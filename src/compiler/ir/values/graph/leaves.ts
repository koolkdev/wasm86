import { assert } from "#common/assert.js";
import type { ValueDefinition } from "./definition.js";
import type { ValueOperation } from "../expression.js";
import { normalizeInteger } from "./integer.js";
import type { ValueWidth } from "#compiler/integer/width.js";
import type { ValueType } from "#compiler/value.js";

type ConstantArgs = Readonly<{
  width: ValueWidth;
  value: number | bigint;
}>;

export type ConstantNode = Readonly<{
  kind: "const";
  width: ValueWidth;
  value: bigint;
}>;

type UnreachableArgs = Readonly<{ width: ValueWidth }>;
export type UnreachableNode = Readonly<UnreachableArgs & { kind: "unreachable" }>;

type NodeOutputArgs = Readonly<{ width: ValueWidth }>;
export type NodeOutputNode = Readonly<NodeOutputArgs & { kind: "nodeOutput" }>;

type LoopInputArgs = Readonly<{ width: ValueWidth }>;
export type LoopInputNode = Readonly<LoopInputArgs & { kind: "loopInput" }>;

type ParameterArgs = Readonly<{
  index: number;
  type: ValueType;
}>;

export type ParameterNode = Readonly<{
  kind: "parameter";
  index: number;
  width: 32 | 64;
}>;

export const constantValue: ValueOperation<ConstantArgs, ConstantArgs, ConstantNode> = {
  resolve: (input) => input,
  create: ({ width, value }) => ({
    kind: "const",
    width,
    value: normalizeInteger(width, value)
  }),
  identity: {
    kind: "canonical",
    key: (node) => [node.width, node.value]
  },
  bitWidth: (node) => node.width,
  constant: (node) => node.value
};

export const unreachableValue: ValueOperation<UnreachableArgs, UnreachableArgs, UnreachableNode> = {
  resolve: (input) => input,
  create: ({ width }) => ({ kind: "unreachable", width }),
  identity: {
    kind: "canonical",
    key: (node) => [node.width]
  },
  bitWidth: (node) => node.width
};

export const nodeOutputValue: ValueDefinition<NodeOutputArgs, NodeOutputNode> = {
  create: ({ width }) => ({ kind: "nodeOutput", width }),
  identity: { kind: "occurrence" },
  bitWidth: (node) => node.width
};

export const loopInputValue: ValueDefinition<LoopInputArgs, LoopInputNode> = {
  create: ({ width }) => ({ kind: "loopInput", width }),
  identity: { kind: "occurrence" },
  bitWidth: (node) => node.width
};

export const parameterValue: ValueDefinition<ParameterArgs, ParameterNode> = {
  create: ({ index, type }) => {
    assert(Number.isInteger(index) && index >= 0, `invalid function parameter index: ${index}`);
    return {
      kind: "parameter",
      index,
      width: type === "i32" ? 32 : 64
    };
  },
  identity: {
    kind: "canonical",
    key: (node) => [node.index, node.width]
  },
  bitWidth: (node) => node.width
};
