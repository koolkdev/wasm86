import { assert } from "#common/assert.js";
import type { WasmInstructionWriter } from "#compiler/encoder/instruction-writer.js";
import {
  binaryArithmetic,
  type BinaryArithmeticOperator
} from "./binary-arithmetic.js";
import {
  binaryBitwise,
  type BinaryBitwiseOperator
} from "./binary-bitwise.js";
import type {
  ValueBoundsContext,
  ValueDefinition,
  ValueFoldContext,
  ValueTrapContext
} from "./definition.js";
import type {
  ValueId,
  ValueType,
  WidthBounds
} from "./types.js";

export type BinaryFoldCase = Readonly<{
  context: ValueFoldContext;
  a: ValueId;
  b: ValueId;
  left: number | undefined;
  right: number | undefined;
}>;

export type BinaryBoundsCase = Readonly<{
  context: ValueBoundsContext;
  a: ValueId;
  b: ValueId;
}>;

export type BinaryTrapCase = Readonly<{
  context: ValueTrapContext;
  type: ValueType;
  a: ValueId;
  b: ValueId;
}>;

export type BinaryDefinition = Readonly<{
  evaluate(a: number, b: number): number;
  fold(value: BinaryFoldCase): ValueId | undefined;
  bounds: WidthBounds | ((value: BinaryBoundsCase) => WidthBounds);
  mayTrap?: (value: BinaryTrapCase) => boolean;
  emitI32(body: WasmInstructionWriter): void;
  emitI64(body: WasmInstructionWriter): void;
}>;

export type BinaryOperator = BinaryArithmeticOperator | BinaryBitwiseOperator;

type BinaryArgs = Readonly<{
  type: ValueType;
  operator: BinaryOperator;
  a: ValueId;
  b: ValueId;
}>;

type BinaryNode = Readonly<BinaryArgs & { kind: "binary" }>;

const binaryOperations: Readonly<Record<BinaryOperator, BinaryDefinition>> = {
  ...binaryArithmetic,
  ...binaryBitwise
};

export const binaryValue: ValueDefinition<BinaryArgs, BinaryNode> = {
  create: ({ type, operator, a, b }) => ({ kind: "binary", type, operator, a, b }),
  identity: {
    kind: "scoped",
    key: (node) => [node.type, node.operator, node.a, node.b]
  },
  inputs: (node) => [
    { value: node.a, type: node.type },
    { value: node.b, type: node.type }
  ],
  resultType: (node) => node.type,
  widthBounds: (node, context) => {
    assert(node.type === "i32", `width bounds requested for ${node.type} binary value`);
    const bounds = binaryOperations[node.operator].bounds;

    return typeof bounds === "function"
      ? bounds({ context, a: node.a, b: node.b })
      : bounds;
  },
  fold: (node, context) => {
    if (node.type !== "i32") {
      return undefined;
    }

    const definition = binaryOperations[node.operator];
    const left = context.constValue(node.a);
    const right = context.constValue(node.b);

    if (left !== undefined && right !== undefined) {
      if (definition.mayTrap?.({
        context,
        type: node.type,
        a: node.a,
        b: node.b
      })) {
        return context.unreachable(node.type);
      }

      return context.constant(definition.evaluate(left, right));
    }

    return definition.fold({
      context,
      a: node.a,
      b: node.b,
      left,
      right
    });
  },
  mayTrap: (node, context) =>
    binaryOperations[node.operator].mayTrap?.({
      context,
      type: node.type,
      a: node.a,
      b: node.b
    }) ?? false,
  captureMode: "compute",
  emit: (_id, node, target) => {
    const definition = binaryOperations[node.operator];

    switch (node.type) {
      case "i32":
        definition.emitI32(target.body);
        break;
      case "i64":
        definition.emitI64(target.body);
        break;
    }
  }
};
