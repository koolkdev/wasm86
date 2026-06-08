import type {
  ExprRecipe,
  ExprRecipeId,
  ValueSnapshotId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import type {
  WasmCacheEntry,
  WasmCachePlan
} from "../plan/index.js";

export class WasmCacheEntryIndex {
  readonly #values: Pick<ValuePlan, "recipes">;
  readonly #byRecipeId = new Map<ExprRecipeId, WasmCacheEntry>();
  readonly #bySnapshotId = new Map<ValueSnapshotId, WasmCacheEntry>();

  constructor(plan: WasmCachePlan, values: Pick<ValuePlan, "recipes">) {
    this.#values = values;

    for (const entry of plan.entries) {
      const recipeId = this.#values.recipes.recipeId(entry.recipe);

      if (recipeId === undefined) {
        throw new Error(`Wasm value cache entry ${entry.id} references an unregistered recipe`);
      }

      this.#byRecipeId.set(recipeId, entry);

      for (const snapshot of entry.requiredSnapshots) {
        this.#bySnapshotId.set(snapshot, entry);
      }
    }
  }

  entryForRecipe(recipe: ExprRecipe): WasmCacheEntry | undefined {
    const recipeId = this.#values.recipes.recipeId(recipe);

    return recipeId === undefined
      ? undefined
      : this.#byRecipeId.get(recipeId);
  }

  entryForSnapshot(snapshot: ValueSnapshotId): WasmCacheEntry {
    return this.#bySnapshotId.get(snapshot) ??
      fail(`snapshot expression ${snapshot} has no selected Wasm cache entry`);
  }

  assertSameRecipe(expected: ExprRecipe, actual: ExprRecipe): void {
    const expectedId = this.#values.recipes.recipeId(expected);
    const actualId = this.#values.recipes.recipeId(actual);

    if (expectedId === undefined || actualId === undefined || expectedId !== actualId) {
      throw new Error("Wasm cache entry recipe does not match emitted recipe");
    }
  }
}

function fail(message: string): never {
  throw new Error(message);
}
