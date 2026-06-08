import { assert } from "#common/assert.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  ValueSnapshotId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import type {
  WasmCacheEntry,
  WasmCachePlan
} from "./plan/index.js";

export class WasmCacheEntryIndex {
  readonly #values: Pick<ValuePlan, "recipes">;
  readonly #byRecipeId = new Map<ExprRecipeId, WasmCacheEntry>();
  readonly #bySnapshotId = new Map<ValueSnapshotId, WasmCacheEntry>();

  constructor(plan: WasmCachePlan, values: Pick<ValuePlan, "recipes">) {
    this.#values = values;

    for (const entry of plan.entries) {
      const recipeId = this.#values.recipes.recipeId(entry.recipe);

      assert(recipeId !== undefined, `Wasm cache entry ${entry.id} references an unregistered recipe`);
      assert(!this.#byRecipeId.has(recipeId), `duplicate selected Wasm cache recipe ${recipeId}`);

      this.#byRecipeId.set(recipeId, entry);

      for (const snapshot of entry.requiredSnapshots) {
        assert(!this.#bySnapshotId.has(snapshot), `duplicate selected Wasm cache snapshot ${snapshot}`);

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

  entryForSnapshot(snapshot: ValueSnapshotId): WasmCacheEntry | undefined {
    return this.#bySnapshotId.get(snapshot);
  }

  requireEntryForSnapshot(snapshot: ValueSnapshotId): WasmCacheEntry {
    const entry = this.entryForSnapshot(snapshot);

    assert(entry !== undefined, `snapshot expression ${snapshot} has no selected Wasm cache entry`);
    return entry;
  }

  assertSameRecipe(expected: ExprRecipe, actual: ExprRecipe): void {
    const expectedId = this.#values.recipes.recipeId(expected);
    const actualId = this.#values.recipes.recipeId(actual);

    assert(
      expectedId !== undefined && actualId !== undefined && expectedId === actualId,
      "Wasm cache entry recipe does not match emitted recipe"
    );
  }
}
