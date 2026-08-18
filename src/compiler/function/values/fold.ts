import { ValueResolver } from "./resolver.js";
import type { AnyNarrowInteger } from "./integer/types.js";

export function foldNarrowValues(
  roots: readonly AnyNarrowInteger[]
): readonly (number | undefined)[] {
  const values = new ValueResolver();

  return roots.map((root) => values.constValue(root));
}
