import type { BlockLayout } from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ValueSnapshotId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import type { WasmRecipeCostModel } from "./cost.js";

export type WasmCacheEntryId = number & { readonly __wasmCacheEntryId: unique symbol };

export type WasmCachePlan = Readonly<{
  entries: readonly WasmCacheEntry[];
}>;

export type WasmCacheEntry = Readonly<{
  id: WasmCacheEntryId;
  recipe: ExprRecipe;
  requiredSnapshots: readonly ValueSnapshotId[];
}>;

export type WasmCachePlanInput = Readonly<{
  layout: BlockLayout;
  values: ValuePlan;
  costModel?: WasmRecipeCostModel;
}>;
