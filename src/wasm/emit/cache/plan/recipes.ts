import type {
  ExprRecipe,
  ExprRecipeId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import { exprChildren } from "#ir/expr/children.js";

export function recipeIdOrThrow(recipes: ValuePlan["recipes"], recipe: ExprRecipe): ExprRecipeId {
  const recipeId = recipes.recipeId(recipe);

  if (recipeId === undefined) {
    throw new Error("Wasm cache plan references an unregistered expression recipe");
  }

  return recipeId;
}

export function recipeChildren(recipe: ExprRecipe): ExprRecipe[] {
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
