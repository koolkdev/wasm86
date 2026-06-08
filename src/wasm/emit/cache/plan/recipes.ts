import type {
  ExprRecipe
} from "#ir/block/planning/values/index.js";
import { bindRecipeChildSlots } from "../../values/children.js";

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
  const children = bindRecipeChildSlots(recipe);

  switch (expr.kind) {
    case "select":
      return [
        children.recipe("whenTrue"),
        children.recipe("whenFalse"),
        children.recipe("condition")
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
