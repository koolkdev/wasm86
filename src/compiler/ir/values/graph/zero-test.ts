import type { ValueId, ValueType } from "#compiler/value.js";
import type { ValueHandle } from "../handle.js";
import type { ValueOperation } from "../expression.js";

export type ZeroTestOperator = "eqz" | "nonzero";

type ZeroTestOperands<Value> = Readonly<{
  operator: ZeroTestOperator;
  value: Value;
}>;

type ZeroTestInput = ZeroTestOperands<ValueHandle<ValueType>>;
type ZeroTestArgs = ZeroTestOperands<ValueId>;

export type ZeroTestNode = Readonly<ZeroTestArgs & { kind: "zeroTest" }>;

export const zeroTestValue: ValueOperation<ZeroTestInput, ZeroTestArgs, ZeroTestNode> = {
  resolve: ({ operator, value }, values) => ({
    operator,
    value: values.value(value)
  }),
  create: ({ operator, value }) => ({ kind: "zeroTest", operator, value }),
  identity: {
    kind: "scoped",
    key: (node) => [node.operator, node.value]
  },
  children: (node) => [node.value],
  bitWidth: () => 1,
  fold: (node, context) => {
    if (node.operator === "nonzero" && context.bitWidth(node.value) === 1) {
      return node.value;
    }
    const value = context.constant(node.value);

    if (value === undefined) {
      return undefined;
    }
    const result = node.operator === "eqz" ? value === 0n : value !== 0n;

    return context.constantValue(1, result ? 1n : 0n);
  }
};
