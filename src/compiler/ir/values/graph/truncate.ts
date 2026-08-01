import { assert } from "#common/assert.js";
import type { ValueOperation } from "../expression.js";
import type { IntegerWidth } from "#compiler/integer/width.js";
import type { ValueId } from "#compiler/ir/value.js";
import type { ValueHandle } from "../handle.js";

type TruncateOperands<Value> = Readonly<{
  width: Exclude<IntegerWidth, 64>;
  value: Value;
}>;

type TruncateInput = TruncateOperands<ValueHandle>;
type TruncateArgs = TruncateOperands<ValueId>;

export type TruncateNode = Readonly<TruncateArgs & { kind: "truncate" }>;

export const truncateValue: ValueOperation<TruncateInput, TruncateArgs, TruncateNode> = {
  resolve: ({ width, value }, values) => ({
    width,
    value: values.value(value)
  }),
  create: ({ width, value }) => ({ kind: "truncate", width, value }),
  identity: {
    kind: "scoped",
    key: (node) => [node.width, node.value]
  },
  children: (node) => [node.value],
  bitWidth: (node) => node.width,
  validate: (node, context) => {
    const sourceWidth = context.bitWidth(node.value);

    assert(
      node.width < sourceWidth,
      `cannot truncate ${sourceWidth}-bit value to ${node.width} bits`
    );
  },
  fold: (node, context) => {
    const value = context.constant(node.value);

    return value === undefined ? undefined : context.constantValue(node.width, value);
  }
};
