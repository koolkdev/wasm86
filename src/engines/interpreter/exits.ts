import type { VariantValue } from "#compiler/layout/variant-codec.js";
import {
  VariantRef,
  variantSet
} from "#compiler/layout/variant.js";

export const interpreterExits = {
  instructionLimit: new VariantRef("interpreter.exit.instruction-limit", [])
} as const;

export const interpreterExitSet = variantSet(
  "interpreter.exit",
  [interpreterExits.instructionLimit]
);

export function instructionLimitExit(): VariantValue<never> {
  return { variant: interpreterExits.instructionLimit, payload: [] };
}
