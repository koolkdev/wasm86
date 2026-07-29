import type { ValueId, ValueType } from "#compiler/value.js";
import type { ValueHandle } from "../handle.js";
import type { ValueOperation } from "../expression.js";

type EqzOperands<Value> = Readonly<{
  value: Value;
}>;

type EqzInput = EqzOperands<ValueHandle<ValueType>>;
type EqzArgs = EqzOperands<ValueId>;

export type EqzNode = Readonly<EqzArgs & { kind: "eqz" }>;

export const eqzValue: ValueOperation<EqzInput, EqzArgs, EqzNode> = {
  resolve: ({ value }, values) => ({ value: values.value(value) }),
  create: ({ value }) => ({ kind: "eqz", value }),
  identity: {
    kind: "scoped",
    key: (node) => [node.value]
  },
  children: (node) => [node.value],
  bitWidth: () => 32,
  fold: (node, context) => {
    const value = context.constant(node.value);

    return value === undefined ? undefined : context.constantValue(32, value === 0n ? 1n : 0n);
  }
};
