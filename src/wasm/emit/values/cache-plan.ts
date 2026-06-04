import type {
  BlockLayout,
  LayoutStep,
  LayoutValueUseId
} from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  SavedExprId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import { exprChildren } from "#ir/expr/children.js";
import {
  defaultWasmRecipeCostModel,
  shouldReuseWasmRecipe,
  wasmRecipeReuseBenefit,
  type WasmRecipeCostModel
} from "./recipe-cost.js";

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

type RecipeOccurrenceSummary = {
  recipe: ExprRecipe;
  occurrenceCount: number;
  uses: Set<LayoutValueUseId>;
};

type MutableEntry = {
  id: WasmCacheEntryId;
  recipe: ExprRecipe;
  reasons: WasmCacheReason[];
  uses: Set<LayoutValueUseId>;
};

export function planWasmCache(input: WasmCachePlanInput): WasmCachePlan {
  return new WasmCachePlanner(input).plan();
}

export class WasmCachePlanner {
  readonly #layout: BlockLayout;
  readonly #savedExprs: ValuePlan["savedExprs"];
  readonly #recipes: ValuePlan["recipes"];
  readonly #costModel: WasmRecipeCostModel;
  readonly #entries = new Map<ExprRecipeId, MutableEntry>();
  readonly #savedEntryIds = new Map<SavedExprId, ExprRecipeId>();
  #nextEntryId = 0;
  #plan: WasmCachePlan | undefined;

  constructor(input: WasmCachePlanInput) {
    this.#layout = input.layout;
    this.#savedExprs = input.values.savedExprs;
    this.#recipes = input.values.recipes;
    this.#costModel = input.costModel ?? defaultWasmRecipeCostModel;
  }

  plan(): WasmCachePlan {
    if (this.#plan === undefined) {
      this.#plan = this.#build();
    }

    return this.#plan;
  }

  #build(): WasmCachePlan {
    this.#addSavedExprEntries();
    const occurrences = this.#collectOccurrences();

    this.#addReuseEntries(occurrences);
    this.#attachUses(occurrences);

    return this.#freezePlan();
  }

  #addSavedExprEntries(): void {
    for (const saved of this.#savedExprs) {
      const recipeId = this.#recipeId(saved.recipe);
      const entry = this.#entryFor(saved.recipe, recipeId);

      this.#savedEntryIds.set(saved.id, recipeId);
      entry.reasons.push(Object.freeze({
        kind: "saved-expr",
        saved: saved.id
      } satisfies WasmCacheReason));
    }
  }

  #collectOccurrences(): ReadonlyMap<ExprRecipeId, RecipeOccurrenceSummary> {
    const occurrences = new Map<ExprRecipeId, RecipeOccurrenceSummary>();

    collectLayoutRecipeOccurrences(this.#layout, occurrences, (recipe) => this.#recipeId(recipe), (id) =>
      this.#recipes.recipe(id), (saved) => this.#savedEntryIds.get(saved)
    );

    for (const saved of this.#savedExprs) {
      collectRecipeOccurrences(saved.recipe, undefined, occurrences, (recipe) => this.#recipeId(recipe), (id) =>
        this.#recipes.recipe(id), (saved) => this.#savedEntryIds.get(saved)
      );
    }

    return occurrences;
  }

  #addReuseEntries(occurrences: ReadonlyMap<ExprRecipeId, RecipeOccurrenceSummary>): void {
    for (const [recipeId, occurrence] of occurrences) {
      const estimatedBenefit = wasmRecipeReuseBenefit(occurrence.recipe, occurrence.occurrenceCount, this.#costModel);

      if (!shouldReuseWasmRecipe(occurrence.recipe, occurrence.occurrenceCount, this.#costModel)) {
        continue;
      }

      this.#entryFor(occurrence.recipe, recipeId).reasons.push(Object.freeze({
        kind: "reuse",
        estimatedBenefit
      } satisfies WasmCacheReason));
    }
  }

  #attachUses(occurrences: ReadonlyMap<ExprRecipeId, RecipeOccurrenceSummary>): void {
    for (const [recipeId, occurrence] of occurrences) {
      const entry = this.#entries.get(recipeId);

      if (entry !== undefined) {
        for (const use of occurrence.uses) {
          entry.uses.add(use);
        }
      }
    }
  }

  #entryFor(recipe: ExprRecipe, recipeId: ExprRecipeId): MutableEntry {
    const existing = this.#entries.get(recipeId);

    if (existing !== undefined) {
      return existing;
    }

    const entry = {
      id: this.#nextEntryId as WasmCacheEntryId,
      recipe,
      reasons: [],
      uses: new Set<LayoutValueUseId>()
    };

    this.#nextEntryId += 1;
    this.#entries.set(recipeId, entry);
    return entry;
  }

  #recipeId(recipe: ExprRecipe): ExprRecipeId {
    const recipeId = this.#recipes.recipeId(recipe);

    if (recipeId === undefined) {
      throw new Error("Wasm cache plan references an unregistered expression recipe");
    }

    return recipeId;
  }

  #freezePlan(): WasmCachePlan {
    return Object.freeze({
      entries: Object.freeze([...this.#entries.values()].map((entry) => Object.freeze({
        id: entry.id,
        recipe: entry.recipe,
        reasons: Object.freeze([...entry.reasons]),
        uses: Object.freeze([...entry.uses])
      } satisfies WasmCacheEntry)))
    } satisfies WasmCachePlan);
  }
}

function collectLayoutRecipeOccurrences(
  layout: BlockLayout,
  occurrences: Map<ExprRecipeId, RecipeOccurrenceSummary>,
  recipeId: (recipe: ExprRecipe) => ExprRecipeId,
  recipeForId: (recipeId: ExprRecipeId) => ExprRecipe,
  savedRecipeId: (saved: SavedExprId) => ExprRecipeId | undefined
): void {
  for (const region of layout.regions) {
    for (const step of region.steps) {
      collectStepRecipeOccurrences(step, occurrences, recipeId, recipeForId, savedRecipeId);
    }
  }
}

function collectStepRecipeOccurrences(
  step: LayoutStep,
  occurrences: Map<ExprRecipeId, RecipeOccurrenceSummary>,
  recipeId: (recipe: ExprRecipe) => ExprRecipeId,
  recipeForId: (recipeId: ExprRecipeId) => ExprRecipe,
  savedRecipeId: (saved: SavedExprId) => ExprRecipeId | undefined
): void {
  switch (step.kind) {
    case "definition":
    case "action":
      for (const input of step.inputs) {
        collectRecipeOccurrences(input.recipe, input.id, occurrences, recipeId, recipeForId, savedRecipeId);
      }
      break;
    case "write-state":
      if (step.value !== undefined) {
        collectRecipeOccurrences(step.value.recipe, step.value.id, occurrences, recipeId, recipeForId, savedRecipeId);
      }
      break;
    case "save-expr":
    case "exit":
      break;
  }
}

function collectRecipeOccurrences(
  recipe: ExprRecipe,
  use: LayoutValueUseId | undefined,
  occurrences: Map<ExprRecipeId, RecipeOccurrenceSummary>,
  recipeId: (recipe: ExprRecipe) => ExprRecipeId,
  recipeForId: (recipeId: ExprRecipeId) => ExprRecipe,
  savedRecipeId: (saved: SavedExprId) => ExprRecipeId | undefined
): void {
  const stack: ExprRecipe[] = [recipe];

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (current.kind === "saved-expr") {
      const targetRecipeId = savedRecipeId(current.saved);

      if (targetRecipeId !== undefined && use !== undefined) {
        summaryFor(occurrences, targetRecipeId, recipeForId(targetRecipeId)).uses.add(use);
      }

      continue;
    }

    const currentRecipeId = recipeId(current);
    const summary = summaryFor(occurrences, currentRecipeId, current);

    summary.occurrenceCount += 1;

    if (use !== undefined) {
      summary.uses.add(use);
    }

    for (const child of recipeChildren(current).reverse()) {
      stack.push(child);
    }
  }
}

function summaryFor(
  occurrences: Map<ExprRecipeId, RecipeOccurrenceSummary>,
  recipeId: ExprRecipeId,
  recipe: ExprRecipe
): RecipeOccurrenceSummary {
  let summary = occurrences.get(recipeId);

  if (summary === undefined) {
    summary = {
      recipe,
      occurrenceCount: 0,
      uses: new Set<LayoutValueUseId>()
    };
    occurrences.set(recipeId, summary);
  }

  return summary;
}

function recipeChildren(recipe: ExprRecipe): ExprRecipe[] {
  switch (recipe.kind) {
    case "inline":
      return exprChildren(recipe.expr).map((expr) =>
        Object.freeze({ kind: "inline", expr } satisfies ExprRecipe)
      );
    case "definition":
      return [recipe.input];
    case "compute":
      return [...recipe.children];
    case "saved-expr":
      return [];
  }
}
