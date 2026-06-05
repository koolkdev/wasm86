import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type { Barrier, DefinitionResult } from "#ir/block/planning/barrier-facts.js";
import type { ExprNeedId } from "#ir/block/planning/expression-needs.js";
import type { ProgramPoint } from "#ir/block/planning/geometry/index.js";
import type { ExprRef } from "#ir/expr/types.js";

export type ValueSnapshotId = number & { readonly __snapshotId: unique symbol };
export type ExprRecipeId = number & { readonly __exprRecipeId: unique symbol };

export type ValuePlan = Readonly<{
  snapshots: readonly ValueSnapshot[];
  recipes: RecipeRegistry;
}>;

export type RecipeRegistry = Readonly<{
  recipeForNeed(need: ExprNeedId): ExprRecipe | undefined;
  recipeIdForNeed(need: ExprNeedId): ExprRecipeId | undefined;
  recipeId(recipe: ExprRecipe): ExprRecipeId | undefined;
  recipe(id: ExprRecipeId): ExprRecipe;
}>;

export type ExprRecipe =
  | Readonly<{ kind: "snapshot"; snapshot: ValueSnapshotId }>
  | Readonly<{
      kind: "expr";
      expr: ExprRef;
      children: readonly ExprRecipe[];
    }>
  | Readonly<{
      kind: "definition";
      definition: BlockDefinitionId;
      input: ExprRecipe;
    }>;

export type ValueSnapshot = Readonly<{
  id: ValueSnapshotId;
  expr: ExprRef;
  establishAt: ProgramPoint;
  recipe: ExprRecipe;
  usedByTopLevelNeeds: readonly ExprNeedId[];
  reason: SnapshotReason;
}>;

export type SnapshotReason =
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
