import { strictEqual } from "node:assert";
import { test } from "node:test";

import { i32, integer, select, u8, type ValueRef } from "#compiler/function/values.js";
import { valueExpression, type ValueExpression } from "#compiler/function/values/expression.js";

function expressionOf(value: ValueRef): ValueExpression {
  return value[valueExpression]();
}

test("integer literals expose canonical bits", () => {
  const expression = expressionOf(integer(8, -1));

  strictEqual(expression.op, "integer.constant");
  strictEqual(expression.width, 8);
  strictEqual(expression.attr, 0xffn);
});

test("integer operations preserve their operator and operand order", () => {
  const left = u8(7);
  const expression = expressionOf(left.add(5));

  strictEqual(expression.op, "integer.binary");
  strictEqual(expression.attr, "add");
  strictEqual(expression.a, left);

  const right = expressionOf(expression.b);
  strictEqual(right.op, "integer.constant");
  strictEqual(right.width, 8);
  strictEqual(right.attr, 5n);
});

test("signed operations retain their selected interpretation", () => {
  const left = u8(0xff);
  const expression = expressionOf(left.signed.lt(0));

  strictEqual(expression.op, "integer.compare");
  strictEqual(expression.width, 1);
  strictEqual(expression.attr, "lt_s");
  strictEqual(expression.a, left);
});

test("integer extensions record their signedness", () => {
  const value = u8(0xff);
  const signed = expressionOf(value.signed.extend(16));
  const unsigned = expressionOf(value.unsigned.extend(16));

  strictEqual(signed.op, "integer.extend");
  strictEqual(signed.width, 16);
  strictEqual(signed.attr, true);
  strictEqual(signed.a, value);
  strictEqual(unsigned.op, "integer.extend");
  strictEqual(unsigned.attr, false);
  strictEqual(unsigned.a, value);
});

test("integer select preserves condition and arm order", () => {
  const condition = i32(0).eqz();
  const whenTrue = u8(1);
  const whenFalse = u8(2);
  const expression = expressionOf(select(condition, whenTrue, whenFalse));

  strictEqual(expression.op, "integer.select");
  strictEqual(expression.a, condition);
  strictEqual(expression.b, whenTrue);
  strictEqual(expression.c, whenFalse);
});
