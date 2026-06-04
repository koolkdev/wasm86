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

type LayoutRecipeUse = Readonly<{
  id: LayoutValueUseId;
  recipe: ExprRecipe;
  recipeId: ExprRecipeId;
}>;

type MutableEntry = {
  id: WasmCacheEntryId;
  recipe: ExprRecipe;
  reasons: WasmCacheReason[];
  uses: LayoutValueUseId[];
};

type ReuseCandidate = {
  recipe: ExprRecipe;
  recipeId: ExprRecipeId;
  uses: LayoutValueUseId[];
};

export function planWasmCache(input: WasmCachePlanInput): WasmCachePlan {
  return new WasmCachePlanner(input).plan();
}

export class WasmCachePlanner {
  readonly #savedExprs: ValuePlan["savedExprs"];
  readonly #recipes: ValuePlan["recipes"];
  readonly #costModel: WasmRecipeCostModel;
  readonly #uses: readonly LayoutRecipeUse[];
  readonly #entries = new Map<ExprRecipeId, MutableEntry>();
  readonly #savedEntryIds = new Map<SavedExprId, ExprRecipeId>();
  #nextEntryId = 0;
  #plan: WasmCachePlan | undefined;

  constructor(input: WasmCachePlanInput) {
    this.#savedExprs = input.values.savedExprs;
    this.#recipes = input.values.recipes;
    this.#costModel = input.costModel ?? defaultWasmRecipeCostModel;
    this.#uses = layoutRecipeUses(input.layout, (recipe) => this.#recipeId(recipe));
  }

  plan(): WasmCachePlan {
    if (this.#plan === undefined) {
      this.#plan = this.#build();
    }

    return this.#plan;
  }

  #build(): WasmCachePlan {
    this.#addSavedExprEntries();
    this.#addReuseEntries();
    this.#attachUses();

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

  #addReuseEntries(): void {
    for (const candidate of reuseCandidates(this.#uses)) {
      const estimatedBenefit = wasmRecipeReuseBenefit(candidate.recipe, candidate.uses.length, this.#costModel);

      if (!shouldReuseWasmRecipe(candidate.recipe, candidate.uses.length, this.#costModel)) {
        continue;
      }

      this.#entryFor(candidate.recipe, candidate.recipeId).reasons.push(Object.freeze({
        kind: "reuse",
        estimatedBenefit
      } satisfies WasmCacheReason));
    }
  }

  #attachUses(): void {
    for (const use of this.#uses) {
      const recipeId = this.#entryIdForUse(use);

      if (recipeId === undefined) {
        continue;
      }

      const entry = this.#entries.get(recipeId);

      if (entry !== undefined) {
        addUse(entry, use.id);
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
      uses: []
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

  #entryIdForUse(use: LayoutRecipeUse): ExprRecipeId | undefined {
    if (use.recipe.kind === "saved-expr") {
      return this.#savedEntryIds.get(use.recipe.saved);
    }

    return use.recipeId;
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

function reuseCandidates(uses: readonly LayoutRecipeUse[]): readonly ReuseCandidate[] {
  const byRecipe = new Map<ExprRecipeId, ReuseCandidate>();

  for (const use of uses) {
    if (use.recipe.kind === "saved-expr") {
      continue;
    }

    let candidate = byRecipe.get(use.recipeId);

    if (candidate === undefined) {
      candidate = {
        recipe: use.recipe,
        recipeId: use.recipeId,
        uses: []
      };
      byRecipe.set(use.recipeId, candidate);
    }

    candidate.uses.push(use.id);
  }

  return Object.freeze([...byRecipe.values()]);
}

function addUse(entry: MutableEntry, use: LayoutValueUseId): void {
  if (!entry.uses.includes(use)) {
    entry.uses.push(use);
  }
}

function layoutRecipeUses(
  layout: BlockLayout,
  recipeId: (recipe: ExprRecipe) => ExprRecipeId
): readonly LayoutRecipeUse[] {
  const uses: LayoutRecipeUse[] = [];

  for (const region of layout.regions) {
    for (const step of region.steps) {
      uses.push(...stepRecipeUses(step, recipeId));
    }
  }

  return Object.freeze(uses);
}

function stepRecipeUses(
  step: LayoutStep,
  recipeId: (recipe: ExprRecipe) => ExprRecipeId
): readonly LayoutRecipeUse[] {
  switch (step.kind) {
    case "definition":
    case "action":
      return step.inputs.map((input) => Object.freeze({
        id: input.id,
        recipe: input.recipe,
        recipeId: recipeId(input.recipe)
      } satisfies LayoutRecipeUse));
    case "write-state":
      return step.value === undefined
        ? []
        : [
          Object.freeze({
            id: step.value.id,
            recipe: step.value.recipe,
            recipeId: recipeId(step.value.recipe)
          } satisfies LayoutRecipeUse)
        ];
    case "save-expr":
    case "exit":
      return [];
  }
}
