import { assert } from "#common/assert.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  ValuePlan,
  ValueSnapshotId
} from "#ir/block/planning/values/index.js";
import {
  shouldReuseWasmRecipe,
  type WasmRecipeCostModel
} from "./cost.js";
import type {
  WasmCacheRecipeUse,
  WasmCacheUseIndex
} from "./use-index.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId
} from "./types.js";

export type WasmCacheSelectionInput = Readonly<{
  useIndex: WasmCacheUseIndex;
  recipes: ValuePlan["recipes"];
  requiredSnapshots: ValuePlan["snapshots"];
  costModel: WasmRecipeCostModel;
}>;

type MutableWasmCacheEntry = {
  id: WasmCacheEntryId;
  recipe: ExprRecipe;
  requiredSnapshots: ValueSnapshotId[];
};

export function selectCacheEntries(input: WasmCacheSelectionInput): readonly WasmCacheEntry[] {
  return new WasmCacheEntrySelector(input).select();
}

class WasmCacheEntrySelector {
  readonly #input: WasmCacheSelectionInput;
  readonly #entries: MutableWasmCacheEntry[] = [];
  readonly #entryByRecipeId = new Map<ExprRecipeId, MutableWasmCacheEntry>();
  #nextEntryId = 0;

  constructor(input: WasmCacheSelectionInput) {
    this.#input = input;
  }

  select(): readonly WasmCacheEntry[] {
    this.#addRequiredSnapshotEntries();
    this.#selectRecipeUses();

    return this.#entries;
  }

  #addRequiredSnapshotEntries(): void {
    for (const snapshot of this.#input.requiredSnapshots) {
      const recipeId = this.#input.recipes.recipeId(snapshot.recipe);

      assert(recipeId !== undefined, "Wasm cache plan references an unregistered snapshot recipe");

      const entry = this.#entryFor(snapshot.recipe, recipeId);

      entry.requiredSnapshots.push(snapshot.id);
    }
  }

  #selectRecipeUses(): void {
    for (const [recipeId, recipeUse] of this.#input.useIndex.byRecipe) {
      this.#selectRecipeUse(recipeId, recipeUse);
    }
  }

  #selectRecipeUse(recipeId: ExprRecipeId, recipeUse: WasmCacheRecipeUse): void {
    if (shouldReuseWasmRecipe(recipeUse.recipe, recipeUse.inlineUseCount, this.#input.costModel)) {
      this.#entryFor(recipeUse.recipe, recipeId);
    }
  }

  #entryFor(recipe: ExprRecipe, recipeId: ExprRecipeId): MutableWasmCacheEntry {
    const existing = this.#entryByRecipeId.get(recipeId);

    if (existing !== undefined) {
      return existing;
    }

    const entry = {
      id: this.#nextEntryId as WasmCacheEntryId,
      recipe,
      requiredSnapshots: []
    };

    this.#nextEntryId += 1;
    this.#entries.push(entry);
    this.#entryByRecipeId.set(recipeId, entry);
    return entry;
  }
}
