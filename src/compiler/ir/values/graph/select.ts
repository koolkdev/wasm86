import { assert } from "#common/assert.js";
import type { ValueOperation } from "../expression.js";
import type { ValueId, ValueType } from "#compiler/value.js";
import type { I32Handle, ValueHandle } from "../handle.js";

type SelectOperands<Condition, Value> = Readonly<{
  condition: Condition;
  whenTrue: Value;
  whenFalse: Value;
}>;

type SelectInput = SelectOperands<I32Handle, ValueHandle<ValueType>>;
type SelectArgs = SelectOperands<ValueId, ValueId>;

export type SelectNode = Readonly<SelectArgs & { kind: "select" }>;

export const selectValue: ValueOperation<SelectInput, SelectArgs, SelectNode> = {
  resolve: ({ condition, whenTrue, whenFalse }, values) => ({
    condition: values.value(condition),
    whenTrue: values.value(whenTrue),
    whenFalse: values.value(whenFalse)
  }),
  create: ({ condition, whenTrue, whenFalse }) => ({
    kind: "select",
    condition,
    whenTrue,
    whenFalse
  }),
  identity: {
    kind: "scoped",
    key: (node) => [node.condition, node.whenTrue, node.whenFalse]
  },
  children: (node) => [node.whenTrue, node.whenFalse, node.condition],
  bitWidth: (node, context) => context.bitWidth(node.whenTrue),
  validate: (node, context) => {
    const conditionWidth = context.bitWidth(node.condition);
    const trueWidth = context.bitWidth(node.whenTrue);
    const falseWidth = context.bitWidth(node.whenFalse);

    assert(conditionWidth === 1, `select condition must be 1 bit, got ${conditionWidth}`);
    assert(
      falseWidth === trueWidth,
      `select alternatives must have one width, got ${trueWidth} and ${falseWidth}`
    );
  },
  fold: (node, context) => {
    if (node.whenTrue === node.whenFalse) {
      return node.whenTrue;
    }
    const condition = context.constant(node.condition);

    return condition === undefined ? undefined : condition === 0n ? node.whenFalse : node.whenTrue;
  }
};
