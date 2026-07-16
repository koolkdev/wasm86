import type { VariantValue } from "#compiler/layout/variant-codec.js";
import {
  VariantRef,
  variantSet
} from "#compiler/layout/variant.js";

export const interpreterExits = {
  budget: new VariantRef("interpreter.exit.budget-exhausted", []),
  miss: new VariantRef("interpreter.exit.decode-miss", [])
} as const;

export const interpreterExitSet = variantSet(
  "interpreter.exit",
  [interpreterExits.budget, interpreterExits.miss]
);

export function budgetExit(): VariantValue<never> {
  return { variant: interpreterExits.budget, payload: [] };
}

export function missExit(): VariantValue<never> {
  return { variant: interpreterExits.miss, payload: [] };
}
