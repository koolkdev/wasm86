import { assert } from "#common/assert.js";
import type { CompareOperator } from "#compiler/integer/operators.js";
import type { ValueOperation } from "../expression.js";
import { signedInteger } from "./integer.js";
import type { IntegerWidth } from "#compiler/integer/width.js";
import type { ValueId, ValueType } from "#compiler/value.js";
import type { ValueHandle } from "../handle.js";

type ComparisonOperands<Value> = Readonly<{
  operator: CompareOperator;
  a: Value;
  b: Value;
}>;

type ComparisonInput = ComparisonOperands<ValueHandle<ValueType>>;
type ComparisonArgs = ComparisonOperands<ValueId>;

export type ComparisonNode = Readonly<ComparisonArgs & { kind: "compare" }>;

export const comparisonValue: ValueOperation<ComparisonInput, ComparisonArgs, ComparisonNode> = {
  resolve: ({ operator, a, b }, values) => ({
    operator,
    a: values.value(a),
    b: values.value(b)
  }),
  create: ({ operator, a, b }) => ({ kind: "compare", operator, a, b }),
  identity: {
    kind: "scoped",
    key: (node) => [node.operator, node.a, node.b]
  },
  children: (node) => [node.a, node.b],
  bitWidth: () => 1,
  validate: (node, context) => {
    const left = context.bitWidth(node.a);
    const right = context.bitWidth(node.b);

    assert(right === left, `comparison operands must have one width, got ${left} and ${right}`);
  },
  fold: (node, context) => {
    const width = context.bitWidth(node.a);
    const left = context.constant(node.a);
    const right = context.constant(node.b);

    if (left !== undefined && right !== undefined) {
      return context.constantValue(
        1,
        evaluateComparison(node.operator, width, left, right) ? 1n : 0n
      );
    }
    if (node.a === node.b) {
      return context.constantValue(1, sameValueResult(node.operator) ? 1n : 0n);
    }
    if (node.operator === "eq" || node.operator === "ne") {
      const zeroTest = node.operator === "eq" ? context.eqz : context.nonzero;

      if (left === 0n) {
        return zeroTest(node.b);
      }
      if (right === 0n) {
        return zeroTest(node.a);
      }
    }
    return undefined;
  }
};

function evaluateComparison(
  operator: CompareOperator,
  width: IntegerWidth,
  left: bigint,
  right: bigint
): boolean {
  switch (operator) {
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "lt_u":
      return left < right;
    case "le_u":
      return left <= right;
    case "gt_u":
      return left > right;
    case "ge_u":
      return left >= right;
    case "lt_s":
      return signedInteger(width, left) < signedInteger(width, right);
    case "le_s":
      return signedInteger(width, left) <= signedInteger(width, right);
    case "gt_s":
      return signedInteger(width, left) > signedInteger(width, right);
    case "ge_s":
      return signedInteger(width, left) >= signedInteger(width, right);
  }
}

function sameValueResult(operator: CompareOperator): boolean {
  switch (operator) {
    case "eq":
    case "le_u":
    case "ge_u":
    case "le_s":
    case "ge_s":
      return true;
    case "ne":
    case "lt_u":
    case "gt_u":
    case "lt_s":
    case "gt_s":
      return false;
  }
}
