import { strictEqual } from "node:assert";
import { test } from "node:test";

import {
  evaluateBinary,
  evaluateBitCount,
  evaluateComparison,
  evaluateExtension,
  evaluateTruncation,
  evaluateZeroTest
} from "../evaluate.js";
import type { BinaryOperator, CompareOperator } from "../operators.js";
import type { IntegerWidth } from "../width.js";

test("binary operations evaluate with their logical integer width", () => {
  const cases: readonly (readonly [BinaryOperator, IntegerWidth, bigint, bigint, bigint])[] = [
    ["add", 8, 0xffn, 2n, 1n],
    ["sub", 8, 1n, 2n, 0xffn],
    ["mul", 8, 0x80n, 2n, 0n],
    ["div_s", 8, 0xf9n, 2n, 0xfdn],
    ["div_u", 8, 0xffn, 2n, 0x7fn],
    ["rem_s", 8, 0xf9n, 4n, 0xfdn],
    ["rem_u", 8, 0xffn, 16n, 0xfn],
    ["xor", 8, 0xf0n, 0xaan, 0x5an],
    ["or", 8, 0x80n, 1n, 0x81n],
    ["and", 8, 0xf0n, 0xaan, 0xa0n],
    ["shl", 8, 1n, 33n, 2n],
    ["shr_s", 8, 0x80n, 33n, 0xc0n],
    ["shr_u", 8, 0x80n, 33n, 0x40n],
    ["rotl", 8, 0x81n, 9n, 3n],
    ["rotr", 8, 0x81n, 9n, 0xc0n],
    ["add", 64, 0xffff_ffff_ffff_ffffn, 1n, 0n],
    ["div_s", 8, 0x80n, 0xffn, 0x80n]
  ];

  for (const [operator, width, left, right, expected] of cases) {
    strictEqual(evaluateBinary(operator, width, left, right), expected, operator);
  }
});

test("comparisons select signed or unsigned interpretation", () => {
  const cases: readonly (readonly [CompareOperator, IntegerWidth, bigint, bigint, boolean])[] = [
    ["eq", 8, 7n, 8n, false],
    ["ne", 8, 7n, 8n, true],
    ["lt_u", 8, 0xffn, 1n, false],
    ["le_u", 8, 1n, 1n, true],
    ["gt_u", 8, 1n, 2n, false],
    ["ge_u", 8, 2n, 1n, true],
    ["lt_s", 8, 0xffn, 0n, true],
    ["le_s", 8, 0n, 0xffn, false],
    ["gt_s", 8, 0n, 0xffn, true],
    ["ge_s", 8, 0xffn, 0n, false]
  ];

  for (const [operator, width, left, right, expected] of cases) {
    strictEqual(evaluateComparison(operator, width, left, right), expected, operator);
  }
});

test("unary operations evaluate within the logical integer width", () => {
  strictEqual(evaluateZeroTest("eqz", 0n), true);
  strictEqual(evaluateZeroTest("nonzero", 0n), false);
  strictEqual(evaluateZeroTest("nonzero", 1n), true);
  strictEqual(evaluateBitCount("popcnt", 8, 0xf0n), 4n);
  strictEqual(evaluateBitCount("ctz", 8, 0n), 8n);
  strictEqual(evaluateBitCount("clz", 8, 1n), 7n);
});

test("conversions preserve the selected bits", () => {
  strictEqual(evaluateTruncation(8, 0x1ffn), 0xffn);
  strictEqual(evaluateExtension(16, 8, false, 0xffn), 0xffn);
  strictEqual(evaluateExtension(16, 8, true, 0xffn), 0xffffn);
});
