import type {
  BlockLayout,
  LayoutRegionId,
  LayoutValueUseId
} from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  SavedExprId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import type { WasmRecipeCostModel } from "./cost.js";

export type WasmCacheEntryId = number & { readonly __wasmCacheEntryId: unique symbol };
export type WasmCacheOccurrenceId = number & { readonly __wasmCacheOccurrenceId: unique symbol };

export type WasmCachePlan = Readonly<{
  entries: readonly WasmCacheEntry[];
  schedule: readonly WasmCacheRegionSchedule[];
}>;

export type WasmCacheEntry = Readonly<{
  id: WasmCacheEntryId;
  recipe: ExprRecipe;
  reasons: readonly WasmCacheReason[];
  uses: readonly LayoutValueUseId[];
}>;

export type WasmCacheRegionSchedule = Readonly<{
  region: LayoutRegionId;
  occurrences: readonly WasmCacheOccurrence[];
}>;

export type WasmCacheOccurrence =
  | WasmCacheRecipeOccurrence
  | WasmCacheSaveExprOccurrence
  | WasmCacheSavedExprOccurrence;

export type WasmCacheOccurrenceBase = Readonly<{
  id: WasmCacheOccurrenceId;
  index: number;
  entry: WasmCacheEntryId;
  step: number;
}>;

export type WasmCacheRecipeOccurrence = WasmCacheOccurrenceBase & Readonly<{
  kind: "recipe";
  depth: number;
  source: WasmCacheOccurrenceSource;
  recipe: ExprRecipe;
}>;

export type WasmCacheSaveExprOccurrence = WasmCacheOccurrenceBase & Readonly<{
  kind: "save-expr";
  saved: SavedExprId;
  recipe: ExprRecipe;
}>;

export type WasmCacheSavedExprOccurrence = WasmCacheOccurrenceBase & Readonly<{
  kind: "saved-expr";
  depth: number;
  source: WasmCacheOccurrenceSource;
  saved: SavedExprId;
}>;

export type WasmCacheOccurrenceSource =
  | Readonly<{
      kind: "layout-use";
      use: LayoutValueUseId;
    }>
  | Readonly<{
      kind: "save-expr";
      saved: SavedExprId;
    }>;

export type WasmCacheReason =
  | Readonly<{
    kind: "saved-expr";
    saved: SavedExprId;
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

export type MutableRegionSchedule = {
  region: LayoutRegionId;
  occurrences: WasmCacheOccurrence[];
};

export type CacheSelection = Readonly<{
  entries: readonly MutableEntry[];
  byRecipeId: ReadonlyMap<ExprRecipeId, MutableEntry>;
  bySavedId: ReadonlyMap<SavedExprId, MutableEntry>;
}>;
