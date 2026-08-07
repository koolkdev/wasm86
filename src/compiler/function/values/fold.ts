import { ValueScope } from "./scope.js";
import type { AnyNarrowInteger } from "./integer/types.js";

export function foldNarrowValues(
  roots: readonly AnyNarrowInteger[]
): readonly (number | undefined)[] {
  const values = new ValueScope();

  return roots.map((root) => values.constValue(root));
}
