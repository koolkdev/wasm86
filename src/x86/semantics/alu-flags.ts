import {
  addStatusFlagValues,
  decStatusFlagValues,
  incStatusFlagValues,
  negStatusFlagValues,
  shiftStatusFlagValues,
  subStatusFlagValues,
  type FlagValueOps,
  type ShiftFlagOp,
  type StatusFlagValues
} from "#x86/flag-values.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import type { OperandWidth } from "#x86/types.js";
import type {
  SemanticsBuilder,
  SimpleFlagSource
} from "#x86/semantics/builder.js";
import type { Value, ValueInput } from "#x86/semantics/refs.js";

export function buildAddResultAndWriteFlags(
  s: SemanticsBuilder,
  input: Readonly<{
    width: OperandWidth;
    left: ValueInput;
    right: ValueInput;
    carryIn?: ValueInput;
  }>
): Value {
  const width = input.width;
  const a = s.project(width, input.left);
  const b = s.project(width, input.right);
  const rawResult = input.carryIn === undefined
    ? s.i32Add(a, b)
    : s.i32Add(s.i32Add(a, b), input.carryIn);
  const result = s.project(width, rawResult);
  const flags = input.carryIn === undefined
    ? addStatusFlagValues<Value>(semanticFlagOps(s), { width, left: a, right: b, result })
    : addStatusFlagValues<Value>(semanticFlagOps(s), {
      width,
      left: a,
      right: b,
      result,
      carryIn: input.carryIn
    });

  writeStatusFlagValues(s, flags);
  return result;
}

export function buildSubResultAndWriteFlags(
  s: SemanticsBuilder,
  input: Readonly<{
    width: OperandWidth;
    left: ValueInput;
    right: ValueInput;
    borrowIn?: ValueInput;
  }>
): Value {
  const width = input.width;
  const a = s.project(width, input.left);
  const b = s.project(width, input.right);
  const rawResult = input.borrowIn === undefined
    ? s.i32Sub(a, b)
    : s.i32Sub(s.i32Sub(a, b), input.borrowIn);
  const result = s.project(width, rawResult);
  const flags = input.borrowIn === undefined
    ? subStatusFlagValues<Value>(semanticFlagOps(s), { width, left: a, right: b, result })
    : subStatusFlagValues<Value>(semanticFlagOps(s), {
      width,
      left: a,
      right: b,
      result,
      borrowIn: input.borrowIn
    });

  writeStatusFlagValues(s, flags);
  return result;
}

export function buildAddResultAndFlagSource(
  s: SemanticsBuilder,
  input: Readonly<{ width: OperandWidth; left: ValueInput; right: ValueInput }>
): Readonly<{ result: Value; source: SimpleFlagSource }> {
  const width = input.width;
  const left = s.project(width, input.left);
  const right = s.project(width, input.right);
  const result = s.project(width, s.i32Add(left, right));

  return {
    result,
    source: { kind: "add", width, left, right, result }
  };
}

export function buildSubResultAndFlagSource(
  s: SemanticsBuilder,
  input: Readonly<{ width: OperandWidth; left: ValueInput; right: ValueInput }>
): Readonly<{ result: Value; source: SimpleFlagSource }> {
  const width = input.width;
  const left = s.project(width, input.left);
  const right = s.project(width, input.right);
  const result = s.project(width, s.i32Sub(left, right));

  return {
    result,
    source: { kind: "sub", width, left, right, result }
  };
}

export function buildLogicResultAndFlagSource(
  s: SemanticsBuilder,
  input: Readonly<{
    width: OperandWidth;
    op: "and" | "or" | "xor";
    left: ValueInput;
    right: ValueInput;
  }>
): Readonly<{ result: Value; source: SimpleFlagSource }> {
  const width = input.width;
  const left = s.project(width, input.left);
  const right = s.project(width, input.right);
  const result = s.project(width, logicResult(s, input.op, left, right));

  return {
    result,
    source: { kind: "logic", width, result }
  };
}

export function buildShiftResultAndWriteFlags(
  s: SemanticsBuilder,
  input: Readonly<{
    op: ShiftFlagOp;
    width: OperandWidth;
    value: ValueInput;
    rawCount: ValueInput;
  }>
): Value {
  const width = input.width;
  const value = s.project(width, input.value);
  const count = s.i32And(input.rawCount, s.const32(0x1f));
  const shiftedResult = s.project(width, shiftResult(s, input.op, width, value, count));
  const result = s.i32Select(s.compare(32, "ne", count, s.const32(0)), shiftedResult, value);
  const oldFlags = readStatusFlags(s);
  const flags = shiftStatusFlagValues(semanticFlagOps(s), {
    op: input.op,
    width,
    value,
    count,
    result,
    oldFlags
  });

  writeStatusFlagValues(s, flags);
  return result;
}

export function buildCmpFlagSource(
  s: SemanticsBuilder,
  input: Readonly<{ width: OperandWidth; left: ValueInput; right: ValueInput }>
): SimpleFlagSource {
  const width = input.width;
  const left = s.project(width, input.left);
  const right = s.project(width, input.right);
  const result = s.project(width, s.i32Sub(left, right));

  return { kind: "sub", width, left, right, result };
}

export function buildTestFlagSource(
  s: SemanticsBuilder,
  input: Readonly<{ width: OperandWidth; left: ValueInput; right: ValueInput }>
): SimpleFlagSource {
  return buildLogicResultAndFlagSource(s, {
    width: input.width,
    op: "and",
    left: input.left,
    right: input.right
  }).source;
}

export function writeIncFlags(
  s: SemanticsBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueInput; result: ValueInput }>
): void {
  writeStatusFlagValues(s, incStatusFlagValues(semanticFlagOps(s), input));
}

export function writeDecFlags(
  s: SemanticsBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueInput; result: ValueInput }>
): void {
  writeStatusFlagValues(s, decStatusFlagValues(semanticFlagOps(s), input));
}

export function writeNegFlags(
  s: SemanticsBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueInput; result: ValueInput }>
): void {
  writeStatusFlagValues(s, negStatusFlagValues(semanticFlagOps(s), input));
}

function shiftResult(
  s: SemanticsBuilder,
  op: ShiftFlagOp,
  width: OperandWidth,
  value: Value,
  count: Value
): Value {
  switch (op) {
    case "shl":
      return s.i32Shl(value, count);
    case "shr":
      return s.i32ShrU(value, count);
    case "sar":
      return s.i32ShrS(signExtendForWidth(s, width, value), count);
  }
}

function signExtendForWidth(
  s: SemanticsBuilder,
  width: OperandWidth,
  value: Value
): Value {
  switch (width) {
    case 8:
      return s.i32Extend8S(value);
    case 16:
      return s.i32Extend16S(value);
    case 32:
      return value;
  }
}

function logicResult(s: SemanticsBuilder, op: "and" | "or" | "xor", left: Value, right: Value): Value {
  switch (op) {
    case "and":
      return s.i32And(left, right);
    case "or":
      return s.i32Or(left, right);
    case "xor":
      return s.i32Xor(left, right);
  }
}

function readStatusFlags(s: SemanticsBuilder): StatusFlagValues<Value> {
  const flags: Partial<Record<X86StatusFlag, Value>> = {};

  for (const flag of x86StatusFlags) {
    flags[flag] = s.readFlag(flag);
  }

  return flags as StatusFlagValues<Value>;
}

function writeStatusFlagValues(
  s: SemanticsBuilder,
  values: Readonly<Partial<Record<X86StatusFlag, ValueInput>>>
): void {
  for (const flag of Object.keys(values) as X86StatusFlag[]) {
    const value = values[flag];

    if (value !== undefined) {
      s.writeFlag(flag, value);
    }
  }
}

function semanticFlagOps(s: SemanticsBuilder): FlagValueOps<Value> {
  return {
    const32: (value) => s.const32(value),
    project: (width, value) => s.project(width, value),
    and: (a, b) => s.i32And(a, b),
    sub: (a, b) => s.i32Sub(a, b),
    xor: (a, b) => s.i32Xor(a, b),
    shrU: (a, b) => s.i32ShrU(a, b),
    popcnt: (value) => s.i32Popcnt(value),
    compare: (width, operator, a, b) => s.compare(width, operator, a, b),
    select: (condition, whenTrue, whenFalse) => s.i32Select(condition, whenTrue, whenFalse)
  };
}
