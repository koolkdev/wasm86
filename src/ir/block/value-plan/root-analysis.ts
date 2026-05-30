import {
  exprDepsForRoot,
  type ExprDeps
} from "#ir/block/expr-deps.js";
import type {
  ExprGraph,
  ExprNodeId
} from "#ir/expr/graph/index.js";
import type { ValueRoot } from "./value-roots.js";

export type RootValueAnalysis = Readonly<{
  valueRoot: ValueRoot;
  key: ExprNodeId;
  deps: ExprDeps;
}>;

export function analyzeValueRoots(
  graph: ExprGraph,
  valueRoots: readonly ValueRoot[]
): readonly RootValueAnalysis[] {
  return Object.freeze(valueRoots.map((valueRoot) => Object.freeze({
    valueRoot,
    key: graph.node(valueRoot.root.expr).id,
    deps: exprDepsForRoot(valueRoot.root)
  } satisfies RootValueAnalysis)));
}
