import { assert } from "#common/assert.js";
import type { ExprRecipe } from "#ir/block/planning/values/index.js";
import {
  exprChildSlots,
  type ExprChildRole
} from "#ir/expr/children.js";

export type WasmBoundRecipeChildren = Readonly<{
  recipe(role: ExprChildRole): ExprRecipe;
}>;

export function bindRecipeChildSlots(
  recipe: Extract<ExprRecipe, { kind: "expr" }>
): WasmBoundRecipeChildren {
  const slots = exprChildSlots(recipe.expr);
  const indexes = new Map<ExprChildRole, number>();

  assert(
    recipe.children.length === slots.length,
    `expr ${recipe.expr.kind} recipe expected ${slots.length} children, ` +
    `got ${recipe.children.length}`
  );

  slots.forEach((slot, index) => {
    assert(!indexes.has(slot.role), `expr ${recipe.expr.kind} has duplicate child role ${slot.role}`);

    indexes.set(slot.role, index);
  });

  const recipeForRole = (role: ExprChildRole): ExprRecipe => {
    const index = indexes.get(role);

    assert(index !== undefined, `expr ${recipe.expr.kind} recipe has no child role ${role}`);
    const child = recipe.children[index];

    assert(child !== undefined, `expr ${recipe.expr.kind} recipe is missing child role ${role}`);
    return child;
  };

  return {
    recipe: recipeForRole
  };
}
