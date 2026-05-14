import {
  jitValueCost,
  jitValueDependencies
} from "#backends/wasm/jit/ir/value-analysis.js";
import { simplifyJitValue } from "#backends/wasm/jit/ir/value-simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/value-types.js";
import type { JitValueSelectionUse } from "./value-cache-selection.js";
import type { JitPlannedValueUse } from "./value-uses.js";

export type JitCacheSelectionUse = JitPlannedValueUse & JitValueSelectionUse;

export function cacheSelectionUsesForPlannedUse(
  use: JitPlannedValueUse,
  ancestors: readonly JitValue[] = []
): readonly JitCacheSelectionUse[] {
  const value = simplifyJitValue(use.value);
  const cacheUse: JitCacheSelectionUse = {
    ...use,
    value,
    emittedCost: jitValueCost(value),
    ancestors
  };
  const childAncestors = [...ancestors, value];

  return [
    cacheUse,
    ...jitValueDependencies(value).flatMap((dependency) =>
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
    pathScope: use.pathScope,
    purpose: use.purpose
  };
}
