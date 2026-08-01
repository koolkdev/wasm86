import { assert } from "#common/assert.js";
import type { ValueOperation } from "../expression.js";
import { signedInteger } from "./integer.js";
import type { IntegerWidth } from "#compiler/integer/width.js";
import type { ValueId } from "#compiler/ir/value.js";
import type { ValueType } from "#compiler/ir/values/types.js";
import type { ValueHandle } from "../handle.js";

type ExtendOperands<Value> = Readonly<{
  width: IntegerWidth;
  value: Value;
  signed: boolean;
}>;

type ExtendInput = ExtendOperands<ValueHandle<ValueType>>;
type ExtendArgs = ExtendOperands<ValueId>;

export type ExtendNode = Readonly<ExtendArgs & { kind: "extend" }>;

export const extendValue: ValueOperation<ExtendInput, ExtendArgs, ExtendNode> = {
  resolve: ({ width, value, signed }, values) => ({
    width,
    value: values.value(value),
    signed
  }),
  create: ({ width, value, signed }) => ({
    kind: "extend",
    width,
    value,
    signed
  }),
  identity: {
    kind: "scoped",
    key: (node) => [node.width, node.signed, node.value]
  },
  children: (node) => [node.value],
  bitWidth: (node) => node.width,
  validate: (node, context) => {
    const sourceWidth = context.bitWidth(node.value);

    assert(
      node.width > sourceWidth,
      `cannot extend ${sourceWidth}-bit value to ${node.width} bits`
    );
  },
  fold: (node, context) => {
    const value = context.constant(node.value);

    if (value === undefined) {
      return undefined;
    }
    const sourceWidth = context.bitWidth(node.value);
    const extended = node.signed ? signedInteger(sourceWidth, value) : value;

    return context.constantValue(node.width, extended);
  }
};
