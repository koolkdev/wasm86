import type {
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
  recipeEmissionChildren,
  recipeIdOrThrow
} from "./recipes.js";
import type {
  RecipeOccurrenceSummary,
  WasmCachePlanInput
} from "./types.js";

export function summarizeRecipeOccurrences(input: Readonly<{
  layout: WasmCachePlanInput["layout"];
  savedExprs: ValuePlan["savedExprs"];
  recipes: ValuePlan["recipes"];
  savedRecipeIds: ReadonlyMap<SavedExprId, ExprRecipeId>;
}>): ReadonlyMap<ExprRecipeId, RecipeOccurrenceSummary> {
  const summaries = new Map<ExprRecipeId, RecipeOccurrenceSummary>();

  for (const region of input.layout.regions) {
    for (const step of region.steps) {
      summarizeStep(step, summaries, input.recipes, input.savedRecipeIds);
    }
  }

  for (const saved of input.savedExprs) {
    summarizeRecipe(saved.recipe, undefined, summaries, input.recipes, input.savedRecipeIds);
  }

  return summaries;
}

function summarizeStep(
  step: LayoutStep,
  summaries: Map<ExprRecipeId, RecipeOccurrenceSummary>,
  recipes: ValuePlan["recipes"],
  savedRecipeIds: ReadonlyMap<SavedExprId, ExprRecipeId>
): void {
  switch (step.kind) {
    case "definition":
    case "action":
      for (const input of step.inputs) {
        summarizeRecipe(input.recipe, input.id, summaries, recipes, savedRecipeIds);
      }
      break;
    case "write-state":
      if (step.value !== undefined) {
        summarizeRecipe(step.value.recipe, step.value.id, summaries, recipes, savedRecipeIds);
      }
      break;
    case "save-expr":
    case "exit":
      break;
  }
}

function summarizeRecipe(
  recipe: ExprRecipe,
  use: LayoutValueUseId | undefined,
  summaries: Map<ExprRecipeId, RecipeOccurrenceSummary>,
  recipes: ValuePlan["recipes"],
  savedRecipeIds: ReadonlyMap<SavedExprId, ExprRecipeId>
): void {
  const stack: ExprRecipe[] = [recipe];

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (current.kind === "saved-expr") {
      const targetRecipeId = savedRecipeIds.get(current.saved);

      if (targetRecipeId !== undefined && use !== undefined) {
        summaryFor(summaries, targetRecipeId, recipes.recipe(targetRecipeId)).uses.add(use);
      }

      continue;
    }

    const currentRecipeId = recipeIdOrThrow(recipes, current);
    const summary = summaryFor(summaries, currentRecipeId, current);

    summary.occurrenceCount += 1;

    if (use !== undefined) {
      summary.uses.add(use);
    }

    for (const child of recipeEmissionChildren(current).reverse()) {
      stack.push(child);
    }
  }
}

function summaryFor(
  summaries: Map<ExprRecipeId, RecipeOccurrenceSummary>,
  recipeId: ExprRecipeId,
  recipe: ExprRecipe
): RecipeOccurrenceSummary {
  let summary = summaries.get(recipeId);

  if (summary === undefined) {
    summary = {
      recipe,
      occurrenceCount: 0,
      uses: new Set<LayoutValueUseId>()
    };
    summaries.set(recipeId, summary);
  }

  return summary;
}
