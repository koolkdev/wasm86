import type { ExprNeedId } from "#ir/block/planning/expression-needs.js";
import type { ProgramPoint } from "#ir/block/planning/geometry/index.js";
import type { ExprNodeId } from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  ExprRecipe,
  SnapshotReason,
  ValueSnapshot,
  ValueSnapshotId
} from "./types.js";

type MutableValueSnapshot = {
  id: ValueSnapshotId;
  exprId: ExprNodeId;
  expr: ExprRef;
  establishAt: ProgramPoint;
  recipe: ExprRecipe;
  usedByTopLevelNeeds: Set<ExprNeedId>;
  reason: SnapshotReason;
};

export class ValueSnapshotRegistry {
  readonly #snapshot: MutableValueSnapshot[] = [];
  readonly #byId = new Map<ValueSnapshotId, MutableValueSnapshot>();
  readonly #byExpr = new Map<ExprNodeId, Map<ProgramPoint, MutableValueSnapshot[]>>();
  #nextId = 0;

  getOrCreate(input: Readonly<{
    exprId: ExprNodeId;
    expr: ExprRef;
    establishAt: ProgramPoint;
    reason: SnapshotReason;
    topLevelNeed: ExprNeedId;
    createRecipe: () => ExprRecipe;
  }>): ValueSnapshotId {
    const existing = this.#find(input.exprId, input.establishAt, input.reason);

    if (existing !== undefined) {
      this.#recordSnapshotUse(existing, input.topLevelNeed, new Set());
      return existing.id;
    }

    const snapshot: MutableValueSnapshot = {
      id: this.#next(),
      exprId: input.exprId,
      expr: input.expr,
      establishAt: input.establishAt,
      recipe: input.createRecipe(),
      usedByTopLevelNeeds: new Set(),
      reason: input.reason
    };

    this.#snapshot.push(snapshot);
    this.#byId.set(snapshot.id, snapshot);
    this.#addToIndex(snapshot);
    this.#recordSnapshotUse(snapshot, input.topLevelNeed, new Set());
    return snapshot.id;
  }

  recordRecipeUse(recipe: ExprRecipe, topLevelNeed: ExprNeedId): void {
    this.#recordRecipeUse(recipe, topLevelNeed, new Set());
  }

  finalize(): readonly ValueSnapshot[] {
    return Object.freeze(this.#snapshot.map((snapshot) => Object.freeze({
      id: snapshot.id,
      expr: snapshot.expr,
      establishAt: snapshot.establishAt,
      recipe: snapshot.recipe,
      usedByTopLevelNeeds: Object.freeze([...snapshot.usedByTopLevelNeeds]),
      reason: snapshot.reason
    } satisfies ValueSnapshot)));
  }

  #next(): ValueSnapshotId {
    const id = this.#nextId;

    this.#nextId += 1;
    return id as ValueSnapshotId;
  }

  #find(exprId: ExprNodeId, establishAt: ProgramPoint, reason: SnapshotReason): MutableValueSnapshot | undefined {
    const byPoint = this.#byExpr.get(exprId);
    const candidates = byPoint?.get(establishAt);

    return candidates?.find((candidate) => snapshotReasonsEqual(candidate.reason, reason));
  }

  #addToIndex(snapshot: MutableValueSnapshot): void {
    let byPoint = this.#byExpr.get(snapshot.exprId);

    if (byPoint === undefined) {
      byPoint = new Map();
      this.#byExpr.set(snapshot.exprId, byPoint);
    }

    const entries = byPoint.get(snapshot.establishAt);

    if (entries === undefined) {
      byPoint.set(snapshot.establishAt, [snapshot]);
    } else {
      entries.push(snapshot);
    }
  }

  #recordSnapshotUse(
    snapshot: MutableValueSnapshot,
    topLevelNeed: ExprNeedId,
    visited: Set<ValueSnapshotId>
  ): void {
    if (visited.has(snapshot.id)) {
      return;
    }

    visited.add(snapshot.id);
    snapshot.usedByTopLevelNeeds.add(topLevelNeed);
    this.#recordRecipeUse(snapshot.recipe, topLevelNeed, visited);
  }

  #recordRecipeUse(
    recipe: ExprRecipe,
    topLevelNeed: ExprNeedId,
    visited: Set<ValueSnapshotId>
  ): void {
    switch (recipe.kind) {
      case "expr":
        for (const child of recipe.children) {
          this.#recordRecipeUse(child, topLevelNeed, visited);
        }
        break;
      case "snapshot": {
        const snapshot = this.#byId.get(recipe.snapshot);

        if (snapshot === undefined) {
          throw new Error(`unknown snapshot expression id: ${recipe.snapshot}`);
        }

        this.#recordSnapshotUse(snapshot, topLevelNeed, visited);
        break;
      }
      case "definition":
        this.#recordRecipeUse(recipe.input, topLevelNeed, visited);
        break;
    }
  }
}

function snapshotReasonsEqual(left: SnapshotReason, right: SnapshotReason): boolean {
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
