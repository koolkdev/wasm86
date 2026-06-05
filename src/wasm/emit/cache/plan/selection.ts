import type { LayoutValueUseId } from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  ValueSnapshotId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import {
  defaultWasmRecipeCostModel,
  shouldReuseWasmRecipe,
  wasmRecipeReuseBenefit
} from "./cost.js";
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
  snapshotRecipeIds: Map<ValueSnapshotId, ExprRecipeId>;
  snapshotEntries: Map<ValueSnapshotId, MutableEntry>;
  nextEntryId: number;
};

export function selectCacheEntries(input: WasmCachePlanInput): CacheSelection {
  const selection: EntrySelection = {
    entries: new Map(),
    snapshotRecipeIds: new Map(),
    snapshotEntries: new Map(),
    nextEntryId: 0
  };
  const costModel = input.costModel ?? defaultWasmRecipeCostModel;

  addValueSnapshotEntries(input.values, selection);

  const summaries = summarizeRecipeOccurrences({
    layout: input.layout,
    snapshots: input.values.snapshots,
    recipes: input.values.recipes,
    snapshotRecipeIds: selection.snapshotRecipeIds
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
    bySnapshotId: selection.snapshotEntries
  } satisfies CacheSelection);
}

function addValueSnapshotEntries(values: ValuePlan, selection: EntrySelection): void {
  for (const snapshot of values.snapshots) {
    const recipeId = recipeIdOrThrow(values.recipes, snapshot.recipe);
    const entry = entryFor(selection, snapshot.recipe, recipeId);

    selection.snapshotRecipeIds.set(snapshot.id, recipeId);
    selection.snapshotEntries.set(snapshot.id, entry);
    entry.reasons.push(Object.freeze({
      kind: "required-snapshot",
      snapshot: snapshot.id
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
