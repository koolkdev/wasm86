import { x86EflagsBitOffset, type X86Flag } from "#x86/flags.js";
import type { SemanticsBuilder } from "#x86/semantics/builder.js";
import type { Value, ValueInput } from "#x86/semantics/refs.js";

export function buildFlagImage(
  s: SemanticsBuilder,
  flags: readonly X86Flag[],
  seed: number
): Value {
  let image: Value = s.const32(seed);

  for (const flag of flags) {
    const bit = s.readFlag(flag);
    const offset = x86EflagsBitOffset[flag];

    image = s.binary("or", image, offset === 0 ? bit : s.binary("shl", bit, s.const32(offset)));
  }

  return image;
}

export function writeFlagsFromImage(
  s: SemanticsBuilder,
  flags: readonly X86Flag[],
  image: ValueInput
): void {
  const one = s.const32(1);

  for (const flag of flags) {
    const offset = x86EflagsBitOffset[flag];
    const shifted = offset === 0 ? image : s.binary("shr_u", image, s.const32(offset));

    s.writeFlag(flag, s.binary("and", shifted, one));
  }
}
