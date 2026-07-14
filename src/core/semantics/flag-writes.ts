import {
  addStatusFlagValues,
  decStatusFlagValues,
  incStatusFlagValues,
  negStatusFlagValues,
  rotateStatusFlagValues,
  shiftStatusFlagValues,
  subStatusFlagValues,
  type RotateFlagOp,
  type ShiftFlagOp,
  type StatusFlagValues
} from "#core/flags/values.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import type { OperandWidth } from "#core/types.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type {
  SemanticsBuilder,
  SimpleFlagSource
} from "#core/semantics/builder.js";
import type { Value, ValueInput } from "#core/semantics/refs.js";
import { semanticFlagOps } from "./flag-value-ops.js";

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
  v: ValueBuilder,
  input: Readonly<{
    width: OperandWidth;
    left: ValueInput;
    right: ValueInput;
    result: ValueInput;
    carryIn?: ValueInput;
  }>
): void {
  writeStatusFlagValues(s, addStatusFlagValues<Value>(semanticFlagOps(v), input));
}

export function writeSubFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  input: Readonly<{
    width: OperandWidth;
    left: ValueInput;
    right: ValueInput;
    result: ValueInput;
    borrowIn?: ValueInput;
  }>
): void {
  writeStatusFlagValues(s, subStatusFlagValues<Value>(semanticFlagOps(v), input));
}

export function writeShiftFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  input: Readonly<{
    op: ShiftFlagOp;
    width: OperandWidth;
    value: ValueInput;
    count: ValueInput;
    result: ValueInput;
  }>
): void {
  writeStatusFlagValues(s, shiftStatusFlagValues(semanticFlagOps(v), {
    ...input,
    oldFlags: readStatusFlags(s)
  }));
}

export function writeRotateFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  input: Readonly<{
    op: RotateFlagOp;
    width: OperandWidth;
    count: ValueInput;
    result: ValueInput;
    carry: ValueInput;
    carryDefined: ValueInput;
    oldCf?: ValueInput;
  }>
): void {
  writeStatusFlagValues(s, rotateStatusFlagValues(semanticFlagOps(v), {
    ...input,
    oldFlags: {
      CF: input.oldCf ?? s.readFlag("CF"),
      OF: s.readFlag("OF")
    }
  }));
}

export function writeIncFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueInput; result: ValueInput }>
): void {
  writeStatusFlagValues(s, incStatusFlagValues(semanticFlagOps(v), input));
}

export function writeDecFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueInput; result: ValueInput }>
): void {
  writeStatusFlagValues(s, decStatusFlagValues(semanticFlagOps(v), input));
}

export function writeNegFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueInput; result: ValueInput }>
): void {
  writeStatusFlagValues(s, negStatusFlagValues(semanticFlagOps(v), input));
}

function readStatusFlags(s: SemanticsBuilder): StatusFlagValues<Value> {
  const flags: Partial<Record<X86StatusFlag, Value>> = {};

  for (const flag of x86StatusFlags) {
    flags[flag] = s.readFlag(flag);
  }

  return flags as StatusFlagValues<Value>;
}

export function writeStatusFlagValues(
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
