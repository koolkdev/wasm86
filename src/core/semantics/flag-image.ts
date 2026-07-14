import { x86EflagsBitOffset, type X86Flag } from "#core/flags/definitions.js";
import type { Values } from "#ir/values.js";
import type { SemanticsBuilder } from "#core/semantics/builder.js";
import type { Value, ValueInput } from "#core/semantics/refs.js";

export function buildFlagImage(
  s: SemanticsBuilder,
  v: Values,
  flags: readonly X86Flag[],
  seed: number
): Value {
  let image: Value = v.const(seed);

  for (const flag of flags) {
    const bit = s.readFlag(flag);
    const offset = x86EflagsBitOffset[flag];

    image = v.binary("or", image, offset === 0 ? bit : v.binary("shl", bit, v.const(offset)));
  }

  return image;
}

export function writeFlagsFromImage(
  s: SemanticsBuilder,
  v: Values,
  flags: readonly X86Flag[],
  image: ValueInput
): void {
  const one = v.const(1);

  for (const flag of flags) {
    const offset = x86EflagsBitOffset[flag];
    const shifted = offset === 0 ? image : v.binary("shr_u", image, v.const(offset));

    s.writeFlag(flag, v.binary("and", shifted, one));
  }
}
