import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type { BarrierFacts, DefinitionResult } from "#ir/block/planning/barrier-facts.js";
import type {
  ExprNeed,
  ExprNeedId
} from "#ir/block/planning/expression-needs.js";
import {
  type ProgramPoint,
  type TimelineGeometry
} from "#ir/block/planning/geometry/index.js";
import {
  buildExprGraph,
  type ExprGraph,
  type ExprNode,
  type ExprNodeId
} from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import { ValueBarrierIndex, type SaveBlocker } from "./barriers.js";
import { MutableRecipeRegistry } from "./recipes.js";
import { SavedExprRegistry } from "./saves.js";
import type {
  ExprRecipe,
  ValuePlan
} from "./types.js";

type InputExprNode = ExprNode & { readonly expr: Extract<ExprRef, { kind: "input" }> };

export type ValuePlanInput = Readonly<{
  needs: readonly ExprNeed[];
  geometry: TimelineGeometry;
  facts: BarrierFacts;
}>;

export function analyzeValuePlan(input: ValuePlanInput): ValuePlan {
  return new ValuePlanAnalyzer(input).analyze();
}

class ValuePlanAnalyzer {
  readonly #needs: readonly ExprNeed[];
  readonly #graph: ExprGraph;
  readonly #barriers: ValueBarrierIndex;
  readonly #recipes: MutableRecipeRegistry;
  readonly #saves = new SavedExprRegistry();
  readonly #memo = new Map<ExprNodeId, Map<ProgramPoint, ExprRecipe>>();

  constructor(input: ValuePlanInput) {
    this.#needs = input.needs;
    this.#graph = buildExprGraph(expressionGraphRoots(input));
    this.#recipes = new MutableRecipeRegistry(this.#graph);
    this.#barriers = new ValueBarrierIndex({
      facts: input.facts,
      geometry: input.geometry
    });
  }

  analyze(): ValuePlan {
    for (const need of this.#needs) {
      const recipe = this.#analyzeExpr(need.expr, need.point, need.id);

      this.#saves.recordRecipeUse(recipe, need.id);
      this.#recipes.recordNeedRecipe(need.id, recipe);
    }

    return Object.freeze({
      savedExprs: this.#saves.finalize(),
      recipes: this.#recipes
    } satisfies ValuePlan);
  }

  #analyzeExpr(expr: ExprRef, point: ProgramPoint, topLevelNeed: ExprNeedId): ExprRecipe {
    const node = this.#graph.node(expr);
    const memoized = this.#memo.get(node.id)?.get(point);

    if (memoized !== undefined) {
      return memoized;
    }

    const recipe = this.#createRecipe(node, point, topLevelNeed);
    let byPoint = this.#memo.get(node.id);

    if (byPoint === undefined) {
      byPoint = new Map();
      this.#memo.set(node.id, byPoint);
    }

    this.#recipes.recordRecipe(recipe);
    byPoint.set(point, recipe);
    return recipe;
  }

  #createRecipe(node: ExprNode, point: ProgramPoint, topLevelNeed: ExprNeedId): ExprRecipe {
    const expr = node.expr;

    switch (expr.kind) {
      case "const":
        return exprRecipe(expr, []);
      case "input":
        return this.#inputRecipe(node as InputExprNode, point, topLevelNeed);
      case "binary":
      case "unary":
      case "select":
      case "project":
      case "bits":
      case "insertBits":
      case "compare":
        return this.#compositeRecipe(node, point, topLevelNeed);
    }
  }

  #inputRecipe(
    node: InputExprNode,
    point: ProgramPoint,
    topLevelNeed: ExprNeedId
  ): ExprRecipe {
    const expr = node.expr;

    switch (expr.source.kind) {
      case "reg":
      case "flag": {
        const blocker = this.#barriers.sourceInputBlocker(expr.source, point);

        return blocker === undefined
          ? exprRecipe(expr, [])
          : this.#savedRecipe(node, blocker, topLevelNeed);
      }
      case "def":
        return this.#definitionInputRecipe(node, point, topLevelNeed);
    }
  }

  #definitionInputRecipe(
    node: InputExprNode,
    point: ProgramPoint,
    topLevelNeed: ExprNeedId
  ): ExprRecipe {
    const expr = node.expr;

    if (expr.source.kind !== "def") {
      throw new Error("definition input recipe requires input(def)");
    }

    const definition = this.#definitionForExpr(expr);

    if (!this.#barriers.definitionExistsAt(definition, point)) {
      throw new Error(`definition ${definition.id} is not available at this program point`);
    }

    const blocker = this.#barriers.definitionReplayBlocker(definition, point);

    if (blocker !== undefined) {
      return this.#savedRecipe(node, blocker, topLevelNeed);
    }

    return Object.freeze({
      kind: "definition",
      definition: definition.id,
      input: this.#analyzeExpr(definition.inputExpr, point, topLevelNeed)
    } satisfies ExprRecipe);
  }

  #compositeRecipe(node: ExprNode, point: ProgramPoint, topLevelNeed: ExprNeedId): ExprRecipe {
    return exprRecipe(
      node.expr,
      node.children.map((child) =>
        this.#analyzeExpr(child.expr, point, topLevelNeed)
      )
    );
  }

  #savedRecipe(node: ExprNode, blocker: SaveBlocker, topLevelNeed: ExprNeedId): ExprRecipe {
    if (!this.#exprExistsAt(node, blocker.saveAt)) {
      throw new Error("cannot save an expression before all of its definition inputs exist");
    }

    const saved = this.#saves.getOrCreate({
      exprId: node.id,
      expr: node.expr,
      saveAt: blocker.saveAt,
      reason: blocker.reason,
      topLevelNeed,
      createRecipe: () => this.#analyzeExpr(node.expr, blocker.saveAt, topLevelNeed)
    });

    return Object.freeze({ kind: "saved-expr", saved } satisfies ExprRecipe);
  }

  #exprExistsAt(node: ExprNode, point: ProgramPoint): boolean {
    const expr = node.expr;

    switch (expr.kind) {
      case "const":
        return true;
      case "input":
        switch (expr.source.kind) {
          case "reg":
          case "flag":
            return true;
          case "def": {
            const definition = this.#definitionForExpr(expr);

            return this.#barriers.definitionExistsAt(definition, point);
          }
        }
      case "binary":
      case "unary":
      case "select":
      case "project":
      case "bits":
      case "insertBits":
      case "compare":
        return node.children.every((child) => this.#exprExistsAt(child, point));
    }
  }

  #definitionForExpr(expr: Extract<ExprRef, { kind: "input" }>): DefinitionResult {
    if (expr.source.kind !== "def") {
      throw new Error("expression is not a definition input");
    }

    const definition = this.#barriers.definition(expr.source.id as BlockDefinitionId);

    if (definition === undefined) {
      throw new Error(`unknown block definition: ${expr.source.id}`);
    }

    return definition;
  }
}

function exprRecipe(expr: ExprRef, children: readonly ExprRecipe[]): ExprRecipe {
  return Object.freeze({
    kind: "expr",
    expr,
    children: Object.freeze([...children])
  } satisfies ExprRecipe);
}

function expressionGraphRoots(input: ValuePlanInput): Iterable<ExprRef> {
  return [
    ...input.needs.map((need) => need.expr),
    ...input.facts.definitions.flatMap((definition) => [
      definition.result,
      definition.inputExpr
    ])
  ];
}
