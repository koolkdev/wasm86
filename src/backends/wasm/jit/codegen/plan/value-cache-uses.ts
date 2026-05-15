import {
  valueCost
} from "#backends/wasm/jit/ir/values/cost.js";
import { valueChildren } from "#backends/wasm/jit/ir/values/walk.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { JitValueSelectionUse } from "./value-cache-selection.js";
import type { JitPlannedValueUse } from "./value-uses.js";

export type JitCacheSelectionUse = JitPlannedValueUse & JitValueSelectionUse;

export function cacheSelectionUsesForPlannedUse(
  use: JitPlannedValueUse,
  ancestors: readonly JitValue[] = []
): readonly JitCacheSelectionUse[] {
  const value = simplifyValue(use.value);
  const cacheUse: JitCacheSelectionUse = {
    ...use,
    value,
    emittedCost: valueCost(value),
    ancestors
  };
  const childAncestors = [...ancestors, value];

  return [
    cacheUse,
    ...valueChildren(value).flatMap((dependency) =>
      cacheSelectionUsesForPlannedUse(
        { ...use, value: dependency },
        childAncestors
      )
    )
  ];
}

export function plannedValueUseFromCacheSelectionUse(
  use: JitCacheSelectionUse
): JitPlannedValueUse {
  return {
    value: use.value,
    placement: use.placement,
    path: use.path,
    purpose: use.purpose
  };
}
