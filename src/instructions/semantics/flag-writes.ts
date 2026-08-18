import {
  addStatusFlagValues,
  decStatusFlagValues,
  incStatusFlagValues,
  negStatusFlagValues,
  rotateStatusFlagValues,
  shiftStatusFlagValues,
  subStatusFlagValues,
  type AddFlagInput,
  type RotateFlagInput,
  type ShiftFlagInput,
  type StatusFlagValues,
  type SubFlagInput,
  type UnaryFlagInput
} from "#core/flags/values.js";
import type { X86StatusFlag } from "#core/flags/definitions.js";
import type { OperandWidth } from "#core/types.js";
import type { BitValue } from "#compiler/function/values.js";
import type { SemanticsBuilder } from "#instructions/semantics/builder.js";

export function writeAddFlags<const Width extends OperandWidth>(
  s: SemanticsBuilder,
  input: AddFlagInput<Width>
): void {
  writeStatusFlagValues(s, addStatusFlagValues(input));
}

export function writeSubFlags<const Width extends OperandWidth>(
  s: SemanticsBuilder,
  input: SubFlagInput<Width>
): void {
  writeStatusFlagValues(s, subStatusFlagValues(input));
}

export function writeShiftFlags<const Width extends OperandWidth>(
  s: SemanticsBuilder,
  input: ShiftFlagInput<Width>
): void {
  writeStatusFlagValues(
    s,
    shiftStatusFlagValues({
      ...input,
      oldFlags: readStatusFlags(s)
    })
  );
}

export function writeRotateFlags<const Width extends OperandWidth>(
  s: SemanticsBuilder,
  input: RotateFlagInput<Width> &
    Readonly<{
      oldCf?: BitValue;
    }>
): void {
  writeStatusFlagValues(
    s,
    rotateStatusFlagValues({
      ...input,
      oldFlags: {
        CF: input.oldCf ?? s.readFlag("CF"),
        OF: s.readFlag("OF")
      }
    })
  );
}

export function writeIncFlags<const Width extends OperandWidth>(
  s: SemanticsBuilder,
  input: UnaryFlagInput<Width>
): void {
  writeStatusFlagValues(s, incStatusFlagValues(input));
}

export function writeDecFlags<const Width extends OperandWidth>(
  s: SemanticsBuilder,
  input: UnaryFlagInput<Width>
): void {
  writeStatusFlagValues(s, decStatusFlagValues(input));
}

export function writeNegFlags<const Width extends OperandWidth>(
  s: SemanticsBuilder,
  input: UnaryFlagInput<Width>
): void {
  writeStatusFlagValues(s, negStatusFlagValues(input));
}

function readStatusFlags(s: SemanticsBuilder): StatusFlagValues {
  return {
    CF: s.readFlag("CF"),
    PF: s.readFlag("PF"),
    AF: s.readFlag("AF"),
    ZF: s.readFlag("ZF"),
    SF: s.readFlag("SF"),
    OF: s.readFlag("OF")
  };
}

export function writeStatusFlagValues(
  s: SemanticsBuilder,
  values: Readonly<Partial<Record<X86StatusFlag, BitValue>>>
): void {
  for (const flag of Object.keys(values) as X86StatusFlag[]) {
    const value = values[flag];

    if (value !== undefined) {
      s.writeFlag(flag, value);
    }
  }
}
