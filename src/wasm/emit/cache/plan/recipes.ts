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

export function recipeEmissionChildren(recipe: ExprRecipe): ExprRecipe[] {
  switch (recipe.kind) {
    case "expr":
      return exprEmissionChildren(recipe);
    case "definition":
      return [recipe.input];
    case "snapshot":
      return [];
  }
}

function exprEmissionChildren(recipe: Extract<ExprRecipe, { kind: "expr" }>): ExprRecipe[] {
  const expr = recipe.expr;

  assertExprRecipeChildCount(recipe);

  switch (expr.kind) {
    case "select":
      return [
        recipe.children[1]!,
        recipe.children[2]!,
        recipe.children[0]!
      ];
    case "const":
    case "input":
    case "binary":
    case "unary":
    case "project":
    case "bits":
    case "insertBits":
    case "compare":
      return [...recipe.children];
  }
}

function assertExprRecipeChildCount(recipe: Extract<ExprRecipe, { kind: "expr" }>): void {
  const expectedChildCount = exprChildren(recipe.expr).length;

  if (recipe.children.length !== expectedChildCount) {
    throw new Error(
      `expr ${recipe.expr.kind} recipe expected ${expectedChildCount} children, ` +
      `got ${recipe.children.length}`
    );
  }
}
