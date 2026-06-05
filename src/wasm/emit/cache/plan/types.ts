import type {
  BlockLayout,
  LayoutValueUseId
} from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ExprRecipeId,
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
  reasons: readonly WasmCacheReason[];
  uses: readonly LayoutValueUseId[];
}>;

export type WasmCacheReason =
  | Readonly<{
    kind: "required-snapshot";
    snapshot: ValueSnapshotId;
  }>
  | Readonly<{
    kind: "reuse";
    estimatedBenefit: number;
  }>;

export type WasmCachePlanInput = Readonly<{
  layout: BlockLayout;
  values: ValuePlan;
  costModel?: WasmRecipeCostModel;
}>;

export type RecipeOccurrenceSummary = {
  recipe: ExprRecipe;
  occurrenceCount: number;
  uses: Set<LayoutValueUseId>;
};

export type MutableEntry = {
  id: WasmCacheEntryId;
  recipe: ExprRecipe;
  reasons: WasmCacheReason[];
  uses: Set<LayoutValueUseId>;
};

export type CacheSelection = Readonly<{
  entries: readonly MutableEntry[];
  byRecipeId: ReadonlyMap<ExprRecipeId, MutableEntry>;
  bySnapshotId: ReadonlyMap<ValueSnapshotId, MutableEntry>;
}>;
