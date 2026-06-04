import type {
  ExprRecipe,
  ExprRecipeId,
  SavedExprId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import type {
  WasmCacheEntry,
  WasmCachePlan
} from "../plan/index.js";

export class WasmCacheEntryIndex {
  readonly #values: Pick<ValuePlan, "recipes">;
  readonly #byRecipeId = new Map<ExprRecipeId, WasmCacheEntry>();
  readonly #bySavedId = new Map<SavedExprId, WasmCacheEntry>();

  constructor(plan: WasmCachePlan, values: Pick<ValuePlan, "recipes">) {
    this.#values = values;

    for (const entry of plan.entries) {
      const recipeId = this.#values.recipes.recipeId(entry.recipe);

      if (recipeId === undefined) {
        throw new Error(`Wasm value cache entry ${entry.id} references an unregistered recipe`);
      }

      this.#byRecipeId.set(recipeId, entry);

      for (const reason of entry.reasons) {
        if (reason.kind === "saved-expr") {
          this.#bySavedId.set(reason.saved, entry);
        }
      }
    }
  }

  entryForRecipe(recipe: ExprRecipe): WasmCacheEntry | undefined {
    const recipeId = this.#values.recipes.recipeId(recipe);

    return recipeId === undefined
      ? undefined
      : this.#byRecipeId.get(recipeId);
  }

  entryForSaved(saved: SavedExprId): WasmCacheEntry {
    return this.#bySavedId.get(saved) ??
      fail(`saved expression ${saved} has no selected Wasm cache entry`);
  }

  assertSameRecipe(expected: ExprRecipe, actual: ExprRecipe): void {
    const expectedId = this.#values.recipes.recipeId(expected);
    const actualId = this.#values.recipes.recipeId(actual);

    if (expectedId === undefined || actualId === undefined || expectedId !== actualId) {
      throw new Error("Wasm cache occurrence recipe does not match emitted recipe");
    }
  }
}

function fail(message: string): never {
  throw new Error(message);
}
