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

export function addFlagSource(
  input: Readonly<{ width: OperandWidth; left: ValueInput; right: ValueInput; result: ValueInput }>
): SimpleFlagSource {
  return { kind: "add", width: input.width, left: input.left, right: input.right, result: input.result };
}

export function subFlagSource(
  input: Readonly<{ width: OperandWidth; left: ValueInput; right: ValueInput; result: ValueInput }>
): SimpleFlagSource {
  return { kind: "sub", width: input.width, left: input.left, right: input.right, result: input.result };
}

export function logicFlagSource(
  input: Readonly<{ width: OperandWidth; result: ValueInput }>
): SimpleFlagSource {
  return { kind: "logic", width: input.width, result: input.result };
}

export function writeAddFlags(
  s: SemanticsBuilder,
  input: Readonly<{
    width: OperandWidth;
    left: ValueInput;
    right: ValueInput;
    result: ValueInput;
    carryIn?: ValueInput;
  }>
): void {
  writeStatusFlagValues(s, addStatusFlagValues<Value>(semanticFlagOps(s), input));
}

export function writeSubFlags(
  s: SemanticsBuilder,
  input: Readonly<{
    width: OperandWidth;
    left: ValueInput;
    right: ValueInput;
    result: ValueInput;
    borrowIn?: ValueInput;
  }>
): void {
  writeStatusFlagValues(s, subStatusFlagValues<Value>(semanticFlagOps(s), input));
}

export function writeShiftFlags(
  s: SemanticsBuilder,
  input: Readonly<{
    op: ShiftFlagOp;
    width: OperandWidth;
    value: ValueInput;
    count: ValueInput;
    result: ValueInput;
  }>
): void {
  writeStatusFlagValues(s, shiftStatusFlagValues(semanticFlagOps(s), {
    ...input,
    oldFlags: readStatusFlags(s)
  }));
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
