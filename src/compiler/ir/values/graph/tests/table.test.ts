import { notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import type { BinaryOperator } from "#compiler/integer/operators.js";
import type { IntegerWidth } from "#compiler/integer/width.js";
import type { ValueId } from "#compiler/ir/value.js";
import { Integer } from "#compiler/ir/values.js";
import { binaryValue } from "../binary.js";
import { bitCountValue } from "../bit-count.js";
import { comparisonValue } from "../comparison.js";
import { extendValue } from "../extend.js";
import { constantValue, unreachableValue } from "../leaves.js";
import { selectValue } from "../select.js";
import { ValueTable } from "../table.js";
import { truncateValue } from "../truncate.js";

test("constants expose normalized logical bits and signed i32 convenience values", () => {
  const values = new ValueTable();
  const byte = constant(values, 8, -1);
  const deadBeef = constant(values, 32, 0xdead_beef);
  const wide = constant(values, 64, -1n);

  strictEqual(values.constant(byte), 0xffn);
  strictEqual(values.constValue(byte), 0xff);
  strictEqual(values.constant(deadBeef), 0xdead_beefn);
  strictEqual(values.constValue(deadBeef), -559_038_737);
  strictEqual(values.constant(wide), 0xffff_ffff_ffff_ffffn);
  strictEqual(values.constValue(wide), undefined);
  strictEqual(values.bitWidth(byte), 8);
  strictEqual(values.bitWidth(wide), 64);
});

test("function parameters retain their exact logical width", () => {
  const values = new ValueTable();
  const byte = values.functionParameter(0, Integer[8]);
  const wide = values.functionParameter(1, Integer[64]);

  strictEqual(values.bitWidth(byte), 8);
  strictEqual(values.bitWidth(wide), 64);
});

test("constant binary operations fold modulo their logical width", () => {
  const values = new ValueTable();

  strictEqual(values.constant(binary(values, 8, "add", 250, 10)), 4n);
  strictEqual(values.constant(binary(values, 8, "div_s", 0xf9, 2)), 0xfdn);
  strictEqual(values.constant(binary(values, 8, "div_u", 0xff, 2)), 0x7fn);
  strictEqual(values.constant(binary(values, 8, "rotl", 0x81, 1)), 3n);
  strictEqual(values.constant(binary(values, 64, "add", 0xffff_ffff_ffff_ffffn, 1n)), 0n);
});

test("signedness belongs to logical operators rather than stored values", () => {
  const values = new ValueTable();
  const allBits = constant(values, 8, 0xff);
  const one = constant(values, 8, 1);
  const signed = values.create(comparisonValue, {
    operator: "lt_s",
    a: allBits,
    b: one
  });
  const unsigned = values.create(comparisonValue, {
    operator: "lt_u",
    a: allBits,
    b: one
  });

  strictEqual(values.constant(signed), 1n);
  strictEqual(values.constant(unsigned), 0n);
  strictEqual(values.bitWidth(signed), 1);
  strictEqual(values.bitWidth(unsigned), 1);
});

test("truncation and extension fold as logical width changes", () => {
  const values = new ValueTable();
  const negativeOne = constant(values, 32, -1);
  const eighty = constant(values, 8, 0x80);
  const truncated = values.create(truncateValue, {
    width: 8,
    value: negativeOne
  });
  const signed = values.create(extendValue, {
    width: 32,
    value: eighty,
    signed: true
  });
  const unsigned = values.create(extendValue, {
    width: 32,
    value: eighty,
    signed: false
  });
  const wideSigned = values.create(extendValue, {
    width: 64,
    value: eighty,
    signed: true
  });

  strictEqual(values.constant(truncated), 0xffn);
  strictEqual(values.constant(signed), 0xffff_ff80n);
  strictEqual(values.constValue(signed), -0x80);
  strictEqual(values.constant(unsigned), 0x80n);
  strictEqual(values.constant(wideSigned), 0xffff_ffff_ffff_ff80n);
});

test("computed values derive one exact logical width", () => {
  const values = new ValueTable();
  const condition = constant(values, 1, 1);
  const count = values.parameter(1, 32);
  const left = values.addNodeOutput(8);
  const right = values.addNodeOutput(8);
  const sum = values.create(binaryValue, {
    operator: "add",
    a: left,
    b: right
  });
  const shifted = values.create(binaryValue, {
    operator: "shl",
    a: sum,
    b: count
  });
  const compared = values.create(comparisonValue, {
    operator: "eq",
    a: shifted,
    b: right
  });
  const selected = values.create(selectValue, {
    condition,
    whenTrue: shifted,
    whenFalse: right
  });
  const countBits = values.create(bitCountValue, {
    operator: "popcnt",
    value: selected
  });

  for (const value of [sum, shifted, selected, countBits]) {
    strictEqual(values.bitWidth(value), 8);
  }
  strictEqual(values.bitWidth(compared), 1);
});

test("scoped identities reuse ancestors without crossing sibling scopes", () => {
  const root = new ValueTable();
  const input = root.parameter(0, 32);
  const one = constant(root, 32, 1);
  const create = (values: ValueTable, operator: BinaryOperator) =>
    values.create(binaryValue, {
      operator,
      a: input,
      b: one
    });
  const ancestor = create(root, "add");

  strictEqual(create(root.childScope(), "add"), ancestor);

  const left = create(root.childScope(), "xor");
  const right = create(root.childScope(), "xor");

  notStrictEqual(left, right);
});

test("occurrence values retain their declared width and identity", () => {
  const values = new ValueTable();
  const first = values.addNodeOutput(8);
  const second = values.addNodeOutput(8);
  const loopInput = values.addLoopInput(16);

  notStrictEqual(first, second);
  strictEqual(values.bitWidth(first), 8);
  strictEqual(values.bitWidth(loopInput), 16);
});

test("unreachable dependencies remain unreachable and are never folded away", () => {
  const values = new ValueTable();
  const unreachable = values.create(unreachableValue, { width: 8 });
  const sum = values.create(binaryValue, {
    operator: "add",
    a: unreachable,
    b: constant(values, 8, 0)
  });

  strictEqual(values.isUnreachable(unreachable), true);
  strictEqual(values.isUnreachable(sum), true);
  strictEqual(values.bitWidth(sum), 8);
});

function constant(values: ValueTable, width: IntegerWidth, value: number | bigint): ValueId {
  return values.create(constantValue, { width, value });
}

function binary(
  values: ValueTable,
  width: IntegerWidth,
  operator: BinaryOperator,
  a: number | bigint,
  b: number | bigint
): ValueId {
  const left = constant(values, width, a);
  const rightWidth =
    operator === "shl" ||
    operator === "shr_s" ||
    operator === "shr_u" ||
    operator === "rotl" ||
    operator === "rotr"
      ? 32
      : width;
  const right = constant(values, rightWidth, b);

  return values.create(binaryValue, {
    operator,
    a: left,
    b: right
  });
}
