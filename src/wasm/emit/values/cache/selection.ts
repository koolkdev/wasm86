import type { LayoutValueUseId } from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  SavedExprId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import {
  defaultWasmRecipeCostModel,
  shouldReuseWasmRecipe,
  wasmRecipeReuseBenefit
} from "../recipe-cost.js";
import { recipeIdOrThrow } from "./recipes.js";
import { summarizeRecipeOccurrences } from "./summary.js";
import type {
  CacheSelection,
  MutableEntry,
  WasmCacheEntryId,
  WasmCachePlanInput,
  WasmCacheReason
} from "./types.js";

type EntrySelection = {
  entries: Map<ExprRecipeId, MutableEntry>;
  savedRecipeIds: Map<SavedExprId, ExprRecipeId>;
  savedEntries: Map<SavedExprId, MutableEntry>;
  nextEntryId: number;
};

export function selectCacheEntries(input: WasmCachePlanInput): CacheSelection {
  const selection: EntrySelection = {
    entries: new Map(),
    savedRecipeIds: new Map(),
    savedEntries: new Map(),
    nextEntryId: 0
  };
  const costModel = input.costModel ?? defaultWasmRecipeCostModel;

  addSavedExprEntries(input.values, selection);

  const summaries = summarizeRecipeOccurrences({
    layout: input.layout,
    savedExprs: input.values.savedExprs,
    recipes: input.values.recipes,
    savedRecipeIds: selection.savedRecipeIds
  });

  for (const [recipeId, summary] of summaries) {
    const estimatedBenefit = wasmRecipeReuseBenefit(summary.recipe, summary.occurrenceCount, costModel);

    if (shouldReuseWasmRecipe(summary.recipe, summary.occurrenceCount, costModel)) {
      entryFor(selection, summary.recipe, recipeId).reasons.push(Object.freeze({
        kind: "reuse",
        estimatedBenefit
      } satisfies WasmCacheReason));
    }

    const entry = selection.entries.get(recipeId);

    if (entry !== undefined) {
      for (const use of summary.uses) {
        entry.uses.add(use);
      }
    }
  }

  return Object.freeze({
    entries: Object.freeze([...selection.entries.values()]),
    byRecipeId: selection.entries,
    bySavedId: selection.savedEntries
  } satisfies CacheSelection);
}

function addSavedExprEntries(values: ValuePlan, selection: EntrySelection): void {
  for (const saved of values.savedExprs) {
    const recipeId = recipeIdOrThrow(values.recipes, saved.recipe);
    const entry = entryFor(selection, saved.recipe, recipeId);

    selection.savedRecipeIds.set(saved.id, recipeId);
    selection.savedEntries.set(saved.id, entry);
    entry.reasons.push(Object.freeze({
      kind: "saved-expr",
      saved: saved.id
    } satisfies WasmCacheReason));
  }
}

function entryFor(selection: EntrySelection, recipe: ExprRecipe, recipeId: ExprRecipeId): MutableEntry {
  const existing = selection.entries.get(recipeId);

  if (existing !== undefined) {
    return existing;
  }

  const entry = {
    id: selection.nextEntryId as WasmCacheEntryId,
    recipe,
    reasons: [],
    uses: new Set<LayoutValueUseId>()
  };

  selection.nextEntryId += 1;
  selection.entries.set(recipeId, entry);
  return entry;
}
