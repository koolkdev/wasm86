import type { BitCountOperator } from "#compiler/integer/operators.js";
import type { ValueWidth } from "#compiler/integer/width.js";
import type { ValueId, ValueType } from "#compiler/value.js";
import type { ValueHandle } from "../handle.js";
import type { ValueOperation } from "../expression.js";

type BitCountOperands<Value> = Readonly<{
  operator: BitCountOperator;
  value: Value;
}>;

type BitCountInput = BitCountOperands<ValueHandle<ValueType>>;
type BitCountArgs = BitCountOperands<ValueId>;

export type BitCountNode = Readonly<BitCountArgs & { kind: "bitCount" }>;

export const bitCountValue: ValueOperation<BitCountInput, BitCountArgs, BitCountNode> = {
  resolve: ({ operator, value }, values) => ({
    operator,
    value: values.value(value)
  }),
  create: ({ operator, value }) => ({ kind: "bitCount", operator, value }),
  identity: {
    kind: "scoped",
    key: (node) => [node.operator, node.value]
  },
  children: (node) => [node.value],
  bitWidth: (node, context) => context.bitWidth(node.value),
  fold: (node, context) => {
    const value = context.constant(node.value);

    return value === undefined
      ? undefined
      : context.constantValue(
          context.bitWidth(node.value),
          evaluateBitCount(node.operator, context.bitWidth(node.value), value)
        );
  }
};

function evaluateBitCount(operator: BitCountOperator, width: ValueWidth, value: bigint): bigint {
  switch (operator) {
    case "popcnt": {
      let remaining = value;
      let count = 0n;

      while (remaining !== 0n) {
        remaining &= remaining - 1n;
        count += 1n;
      }
      return count;
    }
    case "ctz":
      if (value === 0n) {
        return BigInt(width);
      }
      return trailingZeroes(value);
    case "clz":
      return value === 0n ? BigInt(width) : BigInt(width - value.toString(2).length);
  }
}

function trailingZeroes(value: bigint): bigint {
  let remaining = value;
  let count = 0n;

  while ((remaining & 1n) === 0n) {
    remaining >>= 1n;
    count += 1n;
  }
  return count;
}
