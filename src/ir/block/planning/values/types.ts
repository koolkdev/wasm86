import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type { Barrier, DefinitionResult } from "#ir/block/planning/barrier-facts.js";
import type { ExprNeedId } from "#ir/block/planning/expression-needs.js";
import type { ProgramPoint } from "#ir/block/planning/geometry/index.js";
import type { ExprRef } from "#ir/expr/types.js";

export type SavedExprId = number & { readonly __savedExprId: unique symbol };
export type ExprRecipeId = number & { readonly __exprRecipeId: unique symbol };

export type ValuePlan = Readonly<{
  savedExprs: readonly SavedExpr[];
  recipes: RecipeRegistry;
}>;

export type RecipeRegistry = Readonly<{
  recipeForNeed(need: ExprNeedId): ExprRecipe | undefined;
  recipeIdForNeed(need: ExprNeedId): ExprRecipeId | undefined;
  recipeId(recipe: ExprRecipe): ExprRecipeId | undefined;
  recipe(id: ExprRecipeId): ExprRecipe;
}>;

export type ExprRecipe =
  | Readonly<{ kind: "inline"; expr: ExprRef }>
  | Readonly<{ kind: "saved-expr"; saved: SavedExprId }>
  | Readonly<{
      kind: "definition";
      definition: BlockDefinitionId;
      input: ExprRecipe;
    }>
  | Readonly<{
      kind: "compute";
      expr: ExprRef;
      children: readonly ExprRecipe[];
    }>;

export type SavedExpr = Readonly<{
  id: SavedExprId;
  expr: ExprRef;
  saveAt: ProgramPoint;
  recipe: ExprRecipe;
  usedByTopLevelNeeds: readonly ExprNeedId[];
  reason: SaveReason;
}>;

export type SaveReason =
  | Readonly<{
      kind: "source-read-barrier";
      domain: "registers";
      barrier: Barrier;
    }>
  | Readonly<{
      kind: "definition-replay-barrier";
      domain: DefinitionResult["domain"];
      definition: BlockDefinitionId;
      barrier: Barrier;
    }>;
