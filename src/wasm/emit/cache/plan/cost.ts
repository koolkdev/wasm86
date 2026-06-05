import type { ExprRecipe } from "#ir/block/planning/values/index.js";
import type { ExprRef } from "#ir/expr/types.js";

export type WasmRecipeCostModel = Readonly<{
  inlineCost(recipe: ExprRecipe): number;
  cacheFromUseCost: number;
  cacheFromSaveCost: number;
  cachedUseCost: number;
}>;

export const defaultWasmRecipeCostModel: WasmRecipeCostModel = Object.freeze({
  inlineCost: wasmRecipeInlineCost,
  cacheFromUseCost: 1,
  cacheFromSaveCost: 1,
  cachedUseCost: 1
});

export function wasmRecipeInlineCost(recipe: ExprRecipe): number {
  switch (recipe.kind) {
    case "expr":
      return exprOwnCost(recipe.expr) +
        recipe.children.reduce((cost, child) => cost + wasmRecipeInlineCost(child), 0);
    case "saved-expr":
      return 1;
    case "definition":
      return 1 + wasmRecipeInlineCost(recipe.input);
  }
}

export function wasmRecipeReuseBenefit(
  recipe: ExprRecipe,
  useCount: number,
  costModel: WasmRecipeCostModel = defaultWasmRecipeCostModel
): number {
  if (useCount <= 0) {
    return 0;
  }

  const inlineCost = costModel.inlineCost(recipe);
  const repeatedInlineCost = inlineCost * useCount;
  const cacheFromUseCost = inlineCost +
    costModel.cacheFromUseCost +
    costModel.cachedUseCost * (useCount - 1);
  const cacheFromSaveCost = inlineCost +
    costModel.cacheFromSaveCost +
    costModel.cachedUseCost * useCount;

  return repeatedInlineCost - Math.min(cacheFromUseCost, cacheFromSaveCost);
}

export function shouldReuseWasmRecipe(
  recipe: ExprRecipe,
  useCount: number,
  costModel: WasmRecipeCostModel = defaultWasmRecipeCostModel
): boolean {
  return useCount > 1 && wasmRecipeReuseBenefit(recipe, useCount, costModel) > 0;
}

function exprOwnCost(expr: ExprRef): number {
  switch (expr.kind) {
    case "const":
    case "input":
      return 1;
    case "binary":
    case "unary":
    case "select":
    case "project":
    case "bits":
    case "insertBits":
    case "compare":
      return 1;
  }
}
