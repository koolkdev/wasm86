import type { ExprNeedId } from "#ir/block/planning/expression-needs.js";
import type { ProgramPoint } from "#ir/block/planning/geometry/index.js";
import type { ExprNodeId } from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  ExprRecipe,
  SaveReason,
  SavedExpr,
  SavedExprId
} from "./types.js";

type MutableSavedExpr = {
  id: SavedExprId;
  exprId: ExprNodeId;
  expr: ExprRef;
  saveAt: ProgramPoint;
  recipe: ExprRecipe;
  usedByTopLevelNeeds: Set<ExprNeedId>;
  reason: SaveReason;
};

export class SavedExprRegistry {
  readonly #saved: MutableSavedExpr[] = [];
  readonly #byId = new Map<SavedExprId, MutableSavedExpr>();
  readonly #byExpr = new Map<ExprNodeId, Map<ProgramPoint, MutableSavedExpr[]>>();
  #nextId = 0;

  getOrCreate(input: Readonly<{
    exprId: ExprNodeId;
    expr: ExprRef;
    saveAt: ProgramPoint;
    reason: SaveReason;
    topLevelNeed: ExprNeedId;
    createRecipe: () => ExprRecipe;
  }>): SavedExprId {
    const existing = this.#find(input.exprId, input.saveAt, input.reason);

    if (existing !== undefined) {
      this.#recordSavedUse(existing, input.topLevelNeed, new Set());
      return existing.id;
    }

    const saved: MutableSavedExpr = {
      id: this.#next(),
      exprId: input.exprId,
      expr: input.expr,
      saveAt: input.saveAt,
      recipe: input.createRecipe(),
      usedByTopLevelNeeds: new Set(),
      reason: input.reason
    };

    this.#saved.push(saved);
    this.#byId.set(saved.id, saved);
    this.#addToIndex(saved);
    this.#recordSavedUse(saved, input.topLevelNeed, new Set());
    return saved.id;
  }

  recordRecipeUse(recipe: ExprRecipe, topLevelNeed: ExprNeedId): void {
    this.#recordRecipeUse(recipe, topLevelNeed, new Set());
  }

  finalize(): readonly SavedExpr[] {
    return Object.freeze(this.#saved.map((saved) => Object.freeze({
      id: saved.id,
      expr: saved.expr,
      saveAt: saved.saveAt,
      recipe: saved.recipe,
      usedByTopLevelNeeds: Object.freeze([...saved.usedByTopLevelNeeds]),
      reason: saved.reason
    } satisfies SavedExpr)));
  }

  #next(): SavedExprId {
    const id = this.#nextId;

    this.#nextId += 1;
    return id as SavedExprId;
  }

  #find(exprId: ExprNodeId, saveAt: ProgramPoint, reason: SaveReason): MutableSavedExpr | undefined {
    const byPoint = this.#byExpr.get(exprId);
    const candidates = byPoint?.get(saveAt);

    return candidates?.find((candidate) => saveReasonsEqual(candidate.reason, reason));
  }

  #addToIndex(saved: MutableSavedExpr): void {
    let byPoint = this.#byExpr.get(saved.exprId);

    if (byPoint === undefined) {
      byPoint = new Map();
      this.#byExpr.set(saved.exprId, byPoint);
    }

    const entries = byPoint.get(saved.saveAt);

    if (entries === undefined) {
      byPoint.set(saved.saveAt, [saved]);
    } else {
      entries.push(saved);
    }
  }

  #recordSavedUse(
    saved: MutableSavedExpr,
    topLevelNeed: ExprNeedId,
    visited: Set<SavedExprId>
  ): void {
    if (visited.has(saved.id)) {
      return;
    }

    visited.add(saved.id);
    saved.usedByTopLevelNeeds.add(topLevelNeed);
    this.#recordRecipeUse(saved.recipe, topLevelNeed, visited);
  }

  #recordRecipeUse(
    recipe: ExprRecipe,
    topLevelNeed: ExprNeedId,
    visited: Set<SavedExprId>
  ): void {
    switch (recipe.kind) {
      case "inline":
        break;
      case "saved-expr": {
        const saved = this.#byId.get(recipe.saved);

        if (saved === undefined) {
          throw new Error(`unknown saved expression id: ${recipe.saved}`);
        }

        this.#recordSavedUse(saved, topLevelNeed, visited);
        break;
      }
      case "definition":
        this.#recordRecipeUse(recipe.input, topLevelNeed, visited);
        break;
      case "compute":
        for (const child of recipe.children) {
          this.#recordRecipeUse(child, topLevelNeed, visited);
        }
        break;
    }
  }
}

function saveReasonsEqual(left: SaveReason, right: SaveReason): boolean {
  if (left.kind !== right.kind || left.barrier !== right.barrier) {
    return false;
  }

  switch (left.kind) {
    case "source-read-barrier":
      return right.kind === "source-read-barrier" &&
        left.domain === right.domain;
    case "definition-replay-barrier":
      return right.kind === "definition-replay-barrier" &&
        left.domain === right.domain &&
        left.definition === right.definition;
  }
}
