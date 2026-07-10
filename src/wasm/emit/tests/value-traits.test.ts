import { strictEqual } from "node:assert";
import { test } from "node:test";

import type { BinaryOperator, CompareOperator, UnaryOperator } from "#ir/operators.js";
import { ValueTable } from "#ir/value-table.js";
import type { ValueId } from "#ir/values.js";
import { ValueTraits } from "#wasm/emit/value-traits.js";

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
  clz: true
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
    const a = values.addActionOutput();
    const b = values.external(0);
    const binary32 = values.binary(operator, a, b);
    const a64 = values.extend64(32, values.addActionOutput(), true);
    const b64 = values.extend64(32, values.external(1), false);
    const binary64 = values.binary64(operator, a64, b64);
    const traits = new ValueTraits(values);

    strictEqual(traits.isNonTrapping(binary32), expected, `${operator} i32`);
    strictEqual(traits.isNonTrapping(binary64), expected, `${operator} i64`);
  }
});

test("classifies constants and runtime-bound values as nontrapping leaves", () => {
  const values = new ValueTable();
  const leaves = [
    values.const(1),
    values.const64(2n),
    values.external(0),
    values.addActionOutput(),
    values.addLoopInput()
  ];
  const traits = new ValueTraits(values);

  for (const leaf of leaves) {
    strictEqual(traits.isNonTrapping(leaf), true, `leaf value ${leaf}`);
  }
});

test("classifies unreachable values as trapping", () => {
  const values = new ValueTable();
  const unreachable32 = values.unreachable("i32");
  const unreachable64 = values.unreachable("i64");
  const traits = new ValueTraits(values);

  strictEqual(traits.isNonTrapping(unreachable32), false);
  strictEqual(traits.isNonTrapping(unreachable64), false);
});

test("propagates trapping children through every nontrapping binary wrapper", () => {
  for (const [operator, intrinsicallyNonTrapping] of entries(binaryOperatorNonTrapping)) {
    if (!intrinsicallyNonTrapping) {
      continue;
    }

    const values = new ValueTable();
    const safe = values.addActionOutput();
    const divisor = values.external(0);
    const trapping = values.binary("div_u", safe, divisor);
    const trapping64 = values.binary64(
      "div_u",
      values.extend64(32, values.addActionOutput(), true),
      values.extend64(32, values.external(1), false)
    );
    const safe64 = values.extend64(32, values.addActionOutput(), true);
    const left32 = values.binary(operator, trapping, safe);
    const right32 = values.binary(operator, safe, trapping);
    const left64 = values.binary64(operator, trapping64, safe64);
    const right64 = values.binary64(operator, safe64, trapping64);
    const traits = new ValueTraits(values);

    strictEqual(traits.isNonTrapping(left32), false, `${operator} i32 left child`);
    strictEqual(traits.isNonTrapping(right32), false, `${operator} i32 right child`);
    strictEqual(traits.isNonTrapping(left64), false, `${operator} i64 left child`);
    strictEqual(traits.isNonTrapping(right64), false, `${operator} i64 right child`);
  }
});

test("propagates trapping children through every unary wrapper", () => {
  const values = new ValueTable();
  const safe = values.addActionOutput();
  const trapping = values.binary("rem_s", safe, values.external(0));
  const wrapped = entries(unaryOperators).map(([operator]) => (
    [operator, values.unary(operator, safe), values.unary(operator, trapping)] as const
  ));
  const traits = new ValueTraits(values);

  for (const [operator, safeValue, unsafeValue] of wrapped) {
    strictEqual(traits.isNonTrapping(safeValue), true, `${operator} safe child`);
    strictEqual(traits.isNonTrapping(unsafeValue), false, `${operator} trapping child`);
  }
});

test("propagates either trapping operand through every i32 and i64 compare", () => {
  for (const [operator] of entries(compareOperators)) {
    const values = new ValueTable();
    const safe = values.addActionOutput();
    const otherSafe = values.external(2);
    const trapping = values.binary("div_s", safe, values.external(0));
    const trapping64 = values.binary64(
      "rem_u",
      values.extend64(32, values.addActionOutput(), true),
      values.extend64(32, values.external(1), false)
    );
    const safe64 = values.extend64(32, values.addActionOutput(), true);
    const otherSafe64 = values.extend64(32, values.external(3), false);
    const safe32 = values.compare(32, operator, safe, otherSafe);
    const safeComparison64 = values.compare64(operator, safe64, otherSafe64);
    const left32 = values.compare(32, operator, trapping, safe);
    const right32 = values.compare(32, operator, safe, trapping);
    const left64 = values.compare64(operator, trapping64, safe64);
    const right64 = values.compare64(operator, safe64, trapping64);
    const traits = new ValueTraits(values);

    strictEqual(traits.isNonTrapping(safe32), true, `${operator} safe i32 operands`);
    strictEqual(traits.isNonTrapping(safeComparison64), true, `${operator} safe i64 operands`);
    strictEqual(traits.isNonTrapping(left32), false, `${operator} i32 left operand`);
    strictEqual(traits.isNonTrapping(right32), false, `${operator} i32 right operand`);
    strictEqual(traits.isNonTrapping(left64), false, `${operator} i64 left operand`);
    strictEqual(traits.isNonTrapping(right64), false, `${operator} i64 right operand`);
  }
});

test("propagates trapping children through truncate and extend wrappers", () => {
  const values = new ValueTable();
  const trapping = values.binary("div_u", values.addActionOutput(), values.external(0));
  const trapping64 = values.binary64(
    "div_s",
    values.extend64(32, values.addActionOutput(), true),
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
  const traits = new ValueTraits(values);

  for (const wrapper of wrappers) {
    strictEqual(traits.isNonTrapping(wrapper), false, `wrapper value ${wrapper}`);
  }
});

test("requires all three eager select children to be nontrapping", () => {
  const values = new ValueTable();
  const safeCondition = values.external(0);
  const safeTrue = values.addActionOutput();
  const safeFalse = values.addLoopInput();
  const trappingCondition = values.binary("div_u", values.addActionOutput(), values.external(1));
  const trappingTrue = values.binary("rem_s", values.addActionOutput(), values.external(2));
  const trappingFalse = values.binary("div_s", values.addActionOutput(), values.external(3));
  const allSafe = values.select(safeCondition, safeTrue, safeFalse);
  const unsafeCondition = values.select(trappingCondition, safeTrue, safeFalse);
  const unsafeTrue = values.select(safeCondition, trappingTrue, safeFalse);
  const unsafeFalse = values.select(safeCondition, safeTrue, trappingFalse);
  const traits = new ValueTraits(values);

  strictEqual(traits.isNonTrapping(allSafe), true);
  strictEqual(traits.isNonTrapping(unsafeCondition), false);
  strictEqual(traits.isNonTrapping(unsafeTrue), false);
  strictEqual(traits.isNonTrapping(unsafeFalse), false);
});

test("treats an already-bound trapping dependency as a safe replay cut point", () => {
  const values = new ValueTable();
  const dividend = values.addActionOutput();
  const divisor = values.external(0);
  const quotient = values.binary("div_u", dividend, divisor);
  const wrapped = values.binary("add", quotient, values.const(1));
  const traits = new ValueTraits(values);

  strictEqual(traits.isNonTrapping(wrapped), false);
  strictEqual(traits.canEvaluateWithoutTrap(wrapped, () => false), false);
  strictEqual(traits.canEvaluateWithoutTrap(wrapped, (value) => value === quotient), true);
});

test("does not let a bound descendant bypass an unbound trapping operation", () => {
  const values = new ValueTable();
  const dividend = values.addActionOutput();
  const divisor = values.external(0);
  const quotient = values.binary("div_u", dividend, divisor);
  const wrapped = values.binary("add", quotient, values.const(1));
  const traits = new ValueTraits(values);

  strictEqual(traits.canEvaluateWithoutTrap(wrapped, (value) => value === dividend), false);
  strictEqual(traits.canEvaluateWithoutTrap(quotient, (value) => value === quotient), true);
});
