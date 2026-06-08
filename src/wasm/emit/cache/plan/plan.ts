import { defaultWasmRecipeCostModel } from "./cost.js";
import { selectCacheEntries } from "./selection.js";
import { buildWasmCacheUseIndex } from "./use-index.js";
import type {
  WasmCachePlan,
  WasmCachePlanInput
} from "./types.js";

export function planWasmCache(input: WasmCachePlanInput): WasmCachePlan {
  const useIndex = buildWasmCacheUseIndex({
    layout: input.layout,
    recipes: input.values.recipes
  });

  return {
    entries: selectCacheEntries({
      useIndex,
      recipes: input.values.recipes,
      requiredSnapshots: input.values.snapshots,
      costModel: input.costModel ?? defaultWasmRecipeCostModel
    })
  } satisfies WasmCachePlan;
}
