import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type { ExprNeedId } from "#ir/block/planning/expression-needs.js";
import type {
  ExprGraph,
  ExprNodeId
} from "#ir/expr/graph/index.js";
import { exprChildren } from "#ir/expr/children.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  RecipeRegistry as RecipeRegistryContract,
  SavedExprId
} from "./types.js";

export class MutableRecipeRegistry implements RecipeRegistryContract {
  readonly #graph: ExprGraph;
  readonly #recipes: ExprRecipe[] = [];
  readonly #needRecipes = new Map<ExprNeedId, ExprRecipe>();
  readonly #needRecipeIds = new Map<ExprNeedId, ExprRecipeId>();
  readonly #inlineByExpr = new Map<ExprNodeId, ExprRecipeId>();
  readonly #savedById = new Map<SavedExprId, ExprRecipeId>();
  readonly #definitionByInput = new Map<BlockDefinitionId, Map<ExprRecipeId, ExprRecipeId>>();
  readonly #computeByExprAndChildren = new Map<ExprNodeId, RecipeIdSequenceMap<ExprRecipeId>>();

  constructor(graph: ExprGraph) {
    this.#graph = graph;
  }

  recordNeedRecipe(need: ExprNeedId, recipe: ExprRecipe): void {
    this.#needRecipes.set(need, recipe);
    this.#needRecipeIds.set(need, this.recordRecipe(recipe));
  }

  recipeForNeed(need: ExprNeedId): ExprRecipe | undefined {
    return this.#needRecipes.get(need);
  }

  recipeIdForNeed(need: ExprNeedId): ExprRecipeId | undefined {
    return this.#needRecipeIds.get(need);
  }

  recipeId(recipe: ExprRecipe): ExprRecipeId | undefined {
    switch (recipe.kind) {
      case "inline": {
        const exprId = this.#exprNodeId(recipe.expr);

        return exprId === undefined
          ? undefined
          : this.#inlineByExpr.get(exprId);
      }
      case "saved-expr":
        return this.#savedById.get(recipe.saved);
      case "definition": {
        const inputId = this.recipeId(recipe.input);

        return inputId === undefined
          ? undefined
          : this.#definitionByInput.get(recipe.definition)?.get(inputId);
      }
      case "compute": {
        const exprId = this.#exprNodeId(recipe.expr);
        const childIds: ExprRecipeId[] = [];

        if (exprId === undefined) {
          return undefined;
        }

        for (const child of recipe.children) {
          const childId = this.recipeId(child);

          if (childId === undefined) {
            return undefined;
          }

          childIds.push(childId);
        }

        return this.#computeByExprAndChildren.get(exprId)?.get(childIds);
      }
    }
  }

  recordRecipe(recipe: ExprRecipe): ExprRecipeId {
    switch (recipe.kind) {
      case "inline":
        return this.#inlineRecipeId(recipe);
      case "saved-expr":
        return this.#savedRecipeId(recipe);
      case "definition":
        return this.#definitionRecipeId(recipe);
      case "compute":
        return this.#computeRecipeId(recipe);
    }
  }

  recipe(id: ExprRecipeId): ExprRecipe {
    const recipe = this.#recipes[id];

    if (recipe === undefined) {
      throw new Error(`unknown expression recipe id ${id}`);
    }

    return recipe;
  }

  #inlineRecipeId(recipe: Extract<ExprRecipe, { kind: "inline" }>): ExprRecipeId {
    const exprId = this.#graph.node(recipe.expr).id;
    const existing = this.#inlineByExpr.get(exprId);

    if (existing !== undefined) {
      return existing;
    }

    for (const child of exprChildren(recipe.expr)) {
      this.#inlineRecipeId(Object.freeze({ kind: "inline", expr: child } satisfies ExprRecipe));
    }

    const id = this.#next(recipe);

    this.#inlineByExpr.set(exprId, id);
    return id;
  }

  #savedRecipeId(recipe: Extract<ExprRecipe, { kind: "saved-expr" }>): ExprRecipeId {
    const existing = this.#savedById.get(recipe.saved);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#next(recipe);

    this.#savedById.set(recipe.saved, id);
    return id;
  }

  #definitionRecipeId(recipe: Extract<ExprRecipe, { kind: "definition" }>): ExprRecipeId {
    const inputId = this.recordRecipe(recipe.input);
    let byInput = this.#definitionByInput.get(recipe.definition);

    if (byInput === undefined) {
      byInput = new Map();
      this.#definitionByInput.set(recipe.definition, byInput);
    }

    const existing = byInput.get(inputId);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#next(recipe);

    byInput.set(inputId, id);
    return id;
  }

  #computeRecipeId(recipe: Extract<ExprRecipe, { kind: "compute" }>): ExprRecipeId {
    const exprId = this.#graph.node(recipe.expr).id;
    const childIds = recipe.children.map((child) => this.recordRecipe(child));
    let byChildren = this.#computeByExprAndChildren.get(exprId);

    if (byChildren === undefined) {
      byChildren = new RecipeIdSequenceMap();
      this.#computeByExprAndChildren.set(exprId, byChildren);
    }

    const existing = byChildren.get(childIds);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#next(recipe);

    byChildren.set(childIds, id);
    return id;
  }

  #exprNodeId(expr: ExprRef): ExprNodeId | undefined {
    try {
      return this.#graph.node(expr).id;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("expression graph is closed; missing ")
      ) {
        return undefined;
      }

      throw error;
    }
  }

  #next(recipe: ExprRecipe): ExprRecipeId {
    const id = this.#recipes.length as ExprRecipeId;

    this.#recipes.push(recipe);
    return id;
  }
}

type RecipeIdSequenceNode<TValue> = {
  value?: TValue;
  children: Map<ExprRecipeId, RecipeIdSequenceNode<TValue>>;
};

class RecipeIdSequenceMap<TValue> {
  readonly #root: RecipeIdSequenceNode<TValue> = {
    children: new Map()
  };

  get(ids: readonly ExprRecipeId[]): TValue | undefined {
    return this.#node(ids)?.value;
  }

  set(ids: readonly ExprRecipeId[], value: TValue): void {
    let node = this.#root;

    for (const id of ids) {
      let child = node.children.get(id);

      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(id, child);
      }

      node = child;
    }

    node.value = value;
  }

  #node(ids: readonly ExprRecipeId[]): RecipeIdSequenceNode<TValue> | undefined {
    let node = this.#root;

    for (const id of ids) {
      const child = node.children.get(id);

      if (child === undefined) {
        return undefined;
      }

      node = child;
    }

    return node;
  }
}
