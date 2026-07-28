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
import type { SemanticsBuilder } from "#instructions/semantics/builder.js";
import type { Value, ValueInput } from "#instructions/semantics/refs.js";

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
  writeStatusFlagValues(s, addStatusFlagValues(v, input));
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
  writeStatusFlagValues(s, subStatusFlagValues(v, input));
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
  writeStatusFlagValues(
    s,
    shiftStatusFlagValues(v, {
      ...input,
      oldFlags: readStatusFlags(s)
    })
  );
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
  writeStatusFlagValues(
    s,
    rotateStatusFlagValues(v, {
      ...input,
      oldFlags: {
        CF: input.oldCf ?? s.readFlag("CF"),
        OF: s.readFlag("OF")
      }
    })
  );
}

export function writeIncFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueInput; result: ValueInput }>
): void {
  writeStatusFlagValues(s, incStatusFlagValues(v, input));
}

export function writeDecFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueInput; result: ValueInput }>
): void {
  writeStatusFlagValues(s, decStatusFlagValues(v, input));
}

export function writeNegFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueInput; result: ValueInput }>
): void {
  writeStatusFlagValues(s, negStatusFlagValues(v, input));
}

function readStatusFlags(s: SemanticsBuilder): StatusFlagValues {
  const flags: Partial<Record<X86StatusFlag, Value>> = {};

  for (const flag of x86StatusFlags) {
    flags[flag] = s.readFlag(flag);
  }

  return flags as StatusFlagValues;
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
