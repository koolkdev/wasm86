import { strictEqual } from "node:assert";
import { test } from "node:test";

import { f32, f64, i32, select, type ValueRef } from "#compiler/function/values.js";
import { valueExpression, type ValueExpression } from "#compiler/function/values/expression.js";
import type { FloatBinaryOperator, FloatCompareOperator } from "../types.js";

test("float literals expose their exact bits", () => {
  const positiveSingle = expressionOf(f32(0));
  const negativeSingle = expressionOf(f32(-0));
  const positiveDouble = expressionOf(f64(0));
  const negativeDouble = expressionOf(f64(-0));

  strictEqual(positiveSingle.kind, "float");
  strictEqual(positiveSingle.width, 32);
  strictEqual(positiveSingle.op, "float.constant");
  strictEqual(positiveSingle.attr, 0);
  strictEqual(negativeSingle.op, "float.constant");
  strictEqual(negativeSingle.attr, 0x8000_0000);
  strictEqual(positiveDouble.kind, "float");
  strictEqual(positiveDouble.width, 64);
  strictEqual(positiveDouble.op, "float.constant");
  strictEqual(positiveDouble.attr, 0n);
  strictEqual(negativeDouble.op, "float.constant");
  strictEqual(negativeDouble.attr, 0x8000_0000_0000_0000n);
});

test("float operations preserve their operator and operand order", () => {
  const left = f32(1);
  const operations: readonly (readonly [FloatBinaryOperator, ValueRef])[] = [
    ["add", left.add(0.5)],
    ["sub", left.sub(0.5)],
    ["mul", left.mul(0.5)],
    ["div", left.div(0.5)]
  ];

  for (const [operator, value] of operations) {
    const expression = expressionOf(value);

    strictEqual(expression.op, "float.binary");
    strictEqual(expression.attr, operator);
    strictEqual(expression.a, left);

    const right = expressionOf(expression.b);
    strictEqual(right.op, "float.constant");
    strictEqual(right.width, 32);
    strictEqual(right.attr, 0x3f00_0000);
  }
});

test("float comparisons produce integer bits", () => {
  const left = f64(1);
  const comparisons: readonly (readonly [FloatCompareOperator, ValueRef])[] = [
    ["eq", left.eq(2)],
    ["ne", left.ne(2)],
    ["lt", left.lt(2)],
    ["le", left.le(2)],
    ["gt", left.gt(2)],
    ["ge", left.ge(2)]
  ];

  for (const [operator, value] of comparisons) {
    const expression = expressionOf(value);

    strictEqual(expression.kind, "integer");
    strictEqual(expression.width, 1);
    strictEqual(expression.op, "float.compare");
    strictEqual(expression.attr, operator);
    strictEqual(expression.a, left);

    const right = expressionOf(expression.b);
    strictEqual(right.op, "float.constant");
    strictEqual(right.width, 64);
    strictEqual(right.attr, 0x4000_0000_0000_0000n);
  }
});

test("float select preserves condition and arm order", () => {
  const condition = i32(0).eqz();
  const whenTrue = f32(1);
  const whenFalse = f32(2);
  const expression = expressionOf(select(condition, whenTrue, whenFalse));

  strictEqual(expression.op, "float.select");
  strictEqual(expression.width, 32);
  strictEqual(expression.a, condition);
  strictEqual(expression.b, whenTrue);
  strictEqual(expression.c, whenFalse);
});

function expressionOf(value: ValueRef): ValueExpression {
  return value[valueExpression]();
}
