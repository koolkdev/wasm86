import { i32, type Integer, type I32Value } from "#compiler/function/values.js";
import { x86EflagsBitOffset, type X86Flag } from "#core/flags/definitions.js";
import type { OperandWidth } from "#core/types.js";
import type { SemanticsBuilder } from "#instructions/semantics/builder.js";

export function buildFlagImage(
  s: SemanticsBuilder,
  flags: readonly X86Flag[],
  seed: number
): I32Value {
  let image: I32Value = i32(seed);

  for (const flag of flags) {
    const bit = s.readFlag(flag);
    const offset = x86EflagsBitOffset[flag];

    const extendedBit = bit.unsigned.extend(32);

    image = image.or(offset === 0 ? extendedBit : extendedBit.shl(offset));
  }

  return image;
}

export function writeFlagsFromImage<Width extends OperandWidth>(
  s: SemanticsBuilder,
  flags: readonly X86Flag[],
  image: Integer<Width>
): void {
  for (const flag of flags) {
    const offset = x86EflagsBitOffset[flag];

    s.writeFlag(flag, image.bit(offset));
  }
}
