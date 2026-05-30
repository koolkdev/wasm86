import {
  exprDepsForRoot,
  type ExprDeps
} from "#ir/block/expr-deps.js";
import type {
  ExprGraph,
  ExprNodeId
} from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { ValueRoot } from "./value-roots.js";

export type RootValueAnalysis = Readonly<{
  valueRoot: ValueRoot;
  key: ExprNodeId;
  expr: ExprRef;
  deps: ExprDeps;
}>;

export function analyzeValueRoots(
  graph: ExprGraph,
  valueRoots: readonly ValueRoot[]
): readonly RootValueAnalysis[] {
  return Object.freeze(valueRoots.map((valueRoot) => Object.freeze({
    valueRoot,
    key: graph.node(valueRoot.root.expr).id,
    expr: valueRoot.root.expr,
    deps: exprDepsForRoot(valueRoot.root)
  } satisfies RootValueAnalysis)));
}
