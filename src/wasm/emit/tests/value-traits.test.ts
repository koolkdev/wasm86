import { strictEqual } from "node:assert";
import { test } from "node:test";

import type { BinaryOperator } from "#compiler/ir/values/binary.js";
import type { CompareOperator } from "#compiler/ir/values/comparison.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { UnaryOperator } from "#compiler/ir/values/unary.js";

const binaryOperatorNonTrapping = {
  add: true,
  sub: true,
  mul: true,
  div_s: false,
  div_u: false,
  rem_s: false,
  rem_u: false,
  xor: true,
  or: true,
  and: true,
  shl: true,
  rotl: true,
  rotr: true,
  shr_s: true,
  shr_u: true
} as const satisfies Readonly<Record<BinaryOperator, boolean>>;

const unaryOperators = {
  popcnt: true,
  ctz: true,
  clz: true,
  eqz: true
} as const satisfies Readonly<Record<UnaryOperator, true>>;

const compareOperators = {
  eq: true,
  ne: true,
  lt_u: true,
  le_u: true,
  gt_u: true,
  ge_u: true,
  lt_s: true,
  le_s: true,
  gt_s: true,
  ge_s: true
} as const satisfies Readonly<Record<CompareOperator, true>>;

function entries<K extends string, V>(record: Readonly<Record<K, V>>): readonly (readonly [K, V])[] {
  return Object.entries(record) as [K, V][];
}

test("classifies every i32 and i64 binary operator", () => {
  for (const [operator, expected] of entries(binaryOperatorNonTrapping)) {
    const values = new ValueTable();
    const a = values.addNodeOutput();
    const b = values.external(0);
    const binary32 = values.binary(operator, a, b);
    const a64 = values.extend64(32, values.addNodeOutput(), true);
    const b64 = values.extend64(32, values.external(1), false);
    const binary64 = values.binary64(operator, a64, b64);

    strictEqual(values.isNonTrapping(binary32), expected, `${operator} i32`);
    strictEqual(values.isNonTrapping(binary64), expected, `${operator} i64`);
  }
});

test("recognizes division and remainder by nonzero constants as nontrapping", () => {
  for (const operator of ["div_u", "rem_s", "rem_u"] as const) {
    const values = new ValueTable();
    const binary32 = values.binary(operator, values.external(0), values.const(17));
    const binary64 = values.binary64(operator, values.const64(23n), values.const64(17n));

    strictEqual(values.isNonTrapping(binary32), true, `${operator} i32`);
    strictEqual(values.isNonTrapping(binary64), true, `${operator} i64`);
  }
});

test("recognizes signed division by a safe constant divisor", () => {
  const values = new ValueTable();
  const bySeventeen = values.binary("div_s", values.external(0), values.const(17));
  const byNegativeOne = values.binary("div_s", values.external(0), values.const(-1));

  strictEqual(values.isNonTrapping(bySeventeen), true);
  strictEqual(values.isNonTrapping(byNegativeOne), false);
});

test("keeps zero divisors and signed-overflow cases trapping", () => {
  const values = new ValueTable();
  const dividend = values.external(0);
  const byZero = [
    values.binary("div_s", dividend, values.const(0)),
    values.binary("div_u", dividend, values.const(0)),
    values.binary("rem_s", dividend, values.const(0)),
    values.binary("rem_u", dividend, values.const(0))
  ];
  const signedOverflow = values.binary64(
    "div_s",
    values.const64(-0x8000_0000_0000_0000n),
    values.const64(-1n)
  );

  for (const value of byZero) {
    strictEqual(values.isNonTrapping(value), false);
  }
  strictEqual(values.isNonTrapping(signedOverflow), false);
});

test("classifies constants and runtime-bound values as nontrapping leaves", () => {
  const values = new ValueTable();
  const leaves = [
    values.const(1),
    values.const64(2n),
    values.external(0),
    values.addNodeOutput(),
    values.addLoopInput()
  ];

  for (const leaf of leaves) {
    strictEqual(values.isNonTrapping(leaf), true, `leaf value ${leaf}`);
  }
});

test("classifies unreachable values as trapping", () => {
  const values = new ValueTable();
  const unreachable32 = values.unreachable("i32");
  const unreachable64 = values.unreachable("i64");

  strictEqual(values.isNonTrapping(unreachable32), false);
  strictEqual(values.isNonTrapping(unreachable64), false);
});

test("propagates trapping children through every nontrapping binary wrapper", () => {
  for (const [operator, intrinsicallyNonTrapping] of entries(binaryOperatorNonTrapping)) {
    if (!intrinsicallyNonTrapping) {
      continue;
    }

    const values = new ValueTable();
    const safe = values.addNodeOutput();
    const divisor = values.external(0);
    const trapping = values.binary("div_u", safe, divisor);
    const trapping64 = values.binary64(
      "div_u",
      values.extend64(32, values.addNodeOutput(), true),
      values.extend64(32, values.external(1), false)
    );
    const safe64 = values.extend64(32, values.addNodeOutput(), true);
    const left32 = values.binary(operator, trapping, safe);
    const right32 = values.binary(operator, safe, trapping);
    const left64 = values.binary64(operator, trapping64, safe64);
    const right64 = values.binary64(operator, safe64, trapping64);

    strictEqual(values.isNonTrapping(left32), false, `${operator} i32 left child`);
    strictEqual(values.isNonTrapping(right32), false, `${operator} i32 right child`);
    strictEqual(values.isNonTrapping(left64), false, `${operator} i64 left child`);
    strictEqual(values.isNonTrapping(right64), false, `${operator} i64 right child`);
  }
});

test("propagates trapping children through every unary wrapper", () => {
  const values = new ValueTable();
  const safe = values.addNodeOutput();
  const trapping = values.binary("rem_s", safe, values.external(0));
  const wrapped = entries(unaryOperators).map(([operator]) => (
    [operator, values.unary(operator, safe), values.unary(operator, trapping)] as const
  ));

  for (const [operator, safeValue, unsafeValue] of wrapped) {
    strictEqual(values.isNonTrapping(safeValue), true, `${operator} safe child`);
    strictEqual(values.isNonTrapping(unsafeValue), false, `${operator} trapping child`);
  }
});

test("propagates either trapping operand through every i32 and i64 compare", () => {
  for (const [operator] of entries(compareOperators)) {
    const values = new ValueTable();
    const safe = values.addNodeOutput();
    const otherSafe = values.external(2);
    const trapping = values.binary("div_s", safe, values.external(0));
    const trapping64 = values.binary64(
      "rem_u",
      values.extend64(32, values.addNodeOutput(), true),
      values.extend64(32, values.external(1), false)
    );
    const safe64 = values.extend64(32, values.addNodeOutput(), true);
    const otherSafe64 = values.extend64(32, values.external(3), false);
    const safe32 = values.compare(32, operator, safe, otherSafe);
    const safeComparison64 = values.compare64(operator, safe64, otherSafe64);
    const left32 = values.compare(32, operator, trapping, safe);
    const right32 = values.compare(32, operator, safe, trapping);
    const left64 = values.compare64(operator, trapping64, safe64);
    const right64 = values.compare64(operator, safe64, trapping64);

    strictEqual(values.isNonTrapping(safe32), true, `${operator} safe i32 operands`);
    strictEqual(values.isNonTrapping(safeComparison64), true, `${operator} safe i64 operands`);
    strictEqual(values.isNonTrapping(left32), false, `${operator} i32 left operand`);
    strictEqual(values.isNonTrapping(right32), false, `${operator} i32 right operand`);
    strictEqual(values.isNonTrapping(left64), false, `${operator} i64 left operand`);
    strictEqual(values.isNonTrapping(right64), false, `${operator} i64 right operand`);
  }
});

test("propagates trapping children through truncate and extend wrappers", () => {
  const values = new ValueTable();
  const trapping = values.binary("div_u", values.addNodeOutput(), values.external(0));
  const trapping64 = values.binary64(
    "div_s",
    values.extend64(32, values.addNodeOutput(), true),
    values.extend64(32, values.external(1), false)
  );
  const wrappers: readonly ValueId[] = [
    values.truncate(8, trapping),
    values.extend(8, trapping, true),
    values.extend(8, trapping, false),
    values.extend64(8, trapping, true),
    values.extend64(8, trapping, false),
    values.truncate64(32, trapping64)
  ];

  for (const wrapper of wrappers) {
    strictEqual(values.isNonTrapping(wrapper), false, `wrapper value ${wrapper}`);
  }
});

test("requires all three eager select children to be nontrapping", () => {
  const values = new ValueTable();
  const safeCondition = values.external(0);
  const safeTrue = values.addNodeOutput();
  const safeFalse = values.addLoopInput();
  const trappingCondition = values.binary("div_u", values.addNodeOutput(), values.external(1));
  const trappingTrue = values.binary("rem_s", values.addNodeOutput(), values.external(2));
  const trappingFalse = values.binary("div_s", values.addNodeOutput(), values.external(3));
  const allSafe = values.select(safeCondition, safeTrue, safeFalse);
  const unsafeCondition = values.select(trappingCondition, safeTrue, safeFalse);
  const unsafeTrue = values.select(safeCondition, trappingTrue, safeFalse);
  const unsafeFalse = values.select(safeCondition, safeTrue, trappingFalse);

  strictEqual(values.isNonTrapping(allSafe), true);
  strictEqual(values.isNonTrapping(unsafeCondition), false);
  strictEqual(values.isNonTrapping(unsafeTrue), false);
  strictEqual(values.isNonTrapping(unsafeFalse), false);
});
