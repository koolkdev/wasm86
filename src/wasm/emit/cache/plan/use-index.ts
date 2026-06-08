import { assert } from "#common/assert.js";
import type {
  BlockLayout,
  LayoutStep
} from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import { recipeEmissionChildren } from "./recipes.js";

export type WasmCacheUseIndex = Readonly<{
  byRecipe: ReadonlyMap<ExprRecipeId, WasmCacheRecipeUse>;
}>;

export type WasmCacheRecipeUse = Readonly<{
  recipe: ExprRecipe;
  inlineUseCount: number;
}>;

type MutableWasmCacheRecipeUse = {
  recipe: ExprRecipe;
  inlineUseCount: number;
};

export function buildWasmCacheUseIndex(input: Readonly<{
  layout: BlockLayout;
  recipes: ValuePlan["recipes"];
}>): WasmCacheUseIndex {
  return new WasmCacheUseIndexBuilder(input).build();
}

class WasmCacheUseIndexBuilder {
  readonly #input: Readonly<{
    layout: BlockLayout;
    recipes: ValuePlan["recipes"];
  }>;
  readonly #byRecipe = new Map<ExprRecipeId, MutableWasmCacheRecipeUse>();

  constructor(input: Readonly<{
    layout: BlockLayout;
    recipes: ValuePlan["recipes"];
  }>) {
    this.#input = input;
  }

  build(): WasmCacheUseIndex {
    for (const region of this.#input.layout.regions) {
      for (const step of region.steps) {
        this.#indexStep(step);
      }
    }

    return {
      byRecipe: this.#byRecipe
    } satisfies WasmCacheUseIndex;
  }

  #indexStep(step: LayoutStep): void {
    switch (step.kind) {
      case "action-inputs":
      case "action":
        for (const input of step.inputs) {
          this.#indexRecipe(input.recipe);
        }
        break;
      case "establish-snapshot":
        this.#indexRecipe(step.recipe);
        break;
      case "write-state":
        if (step.value !== undefined) {
          this.#indexRecipe(step.value.recipe);
        }
        break;
      case "exit":
        break;
    }
  }

  #indexRecipe(recipe: ExprRecipe): void {
    const stack: ExprRecipe[] = [recipe];

    while (stack.length > 0) {
      const current = stack.pop()!;

      if (current.kind === "snapshot") {
        continue;
      }

      const currentRecipeId = this.#input.recipes.recipeId(current);

      assert(currentRecipeId !== undefined, "Wasm cache use index references an unregistered expression recipe");

      const indexedUse = this.#useFor(currentRecipeId, current);

      indexedUse.inlineUseCount += 1;

      for (const child of recipeEmissionChildren(current).reverse()) {
        stack.push(child);
      }
    }
  }

  #useFor(recipeId: ExprRecipeId, recipe: ExprRecipe): MutableWasmCacheRecipeUse {
    let indexedUse = this.#byRecipe.get(recipeId);

    if (indexedUse === undefined) {
      indexedUse = {
        recipe,
        inlineUseCount: 0
      };
      this.#byRecipe.set(recipeId, indexedUse);
    }

    return indexedUse;
  }
}
