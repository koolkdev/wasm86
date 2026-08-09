import { strictEqual } from "node:assert";
import { test } from "node:test";

import { evaluateBinary, evaluateComparison } from "../evaluate.js";
import type { FloatBinaryOperator, FloatCompareOperator } from "../types.js";

test("float arithmetic evaluates raw IEEE bits at its width", () => {
  const singleCases: readonly (readonly [FloatBinaryOperator, number, number, number])[] = [
    ["add", 0x3fc0_0000, 0x4010_0000, 0x4070_0000],
    ["sub", 0x3f80_0000, 0x4000_0000, 0xbf80_0000],
    ["mul", 0x3fc0_0000, 0x4000_0000, 0x4040_0000],
    ["div", 0x4040_0000, 0x4000_0000, 0x3fc0_0000],
    ["add", 0x4b80_0000, 0x3f80_0000, 0x4b80_0000],
    ["div", 0x3f80_0000, 0x8000_0000, 0xff80_0000],
    ["div", 0x3f80_0000, 0x0000_0000, 0x7f80_0000]
  ];

  for (const [operator, left, right, expected] of singleCases) {
    strictEqual(evaluateBinary(operator, 32, left, right), expected, operator);
  }

  strictEqual(
    evaluateBinary("add", 64, 0x3ff0_0000_0000_0000n, 0x4000_0000_0000_0000n),
    0x4008_0000_0000_0000n
  );
});

test("float comparisons use IEEE values rather than bit ordering", () => {
  const cases: readonly (readonly [FloatCompareOperator, number, number, boolean])[] = [
    ["eq", 0x0000_0000, 0x8000_0000, true],
    ["ne", 0x3f80_0000, 0x3f80_0000, false],
    ["lt", 0xc000_0000, 0x3f80_0000, true],
    ["le", 0x4000_0000, 0x3f80_0000, false],
    ["gt", 0x4000_0000, 0x3f80_0000, true],
    ["ge", 0xbf80_0000, 0xc000_0000, true]
  ];

  for (const [operator, left, right, expected] of cases) {
    strictEqual(evaluateComparison(operator, 32, left, right), expected, operator);
  }
});

test("NaN arithmetic has no chosen payload, while NaN comparisons are defined", () => {
  strictEqual(evaluateBinary("add", 32, 0x7fc0_1234, 0x3f80_0000), undefined);
  strictEqual(evaluateBinary("div", 32, 0x0000_0000, 0x0000_0000), undefined);
  strictEqual(evaluateBinary("add", 64, 0x7ff8_0000_0000_1234n, 0x3ff0_0000_0000_0000n), undefined);

  const cases: readonly (readonly [FloatCompareOperator, boolean])[] = [
    ["eq", false],
    ["ne", true],
    ["lt", false],
    ["le", false],
    ["gt", false],
    ["ge", false]
  ];

  for (const [operator, expected] of cases) {
    strictEqual(evaluateComparison(operator, 32, 0x7fc0_1234, 0x3f80_0000), expected, operator);
  }
});
