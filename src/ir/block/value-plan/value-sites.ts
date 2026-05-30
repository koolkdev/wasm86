import {
  exprDepsForRoot,
  type ExprDeps
} from "#ir/block/expr-deps.js";
import type {
  BlockRoot,
  BoundaryRootCellSource
} from "#ir/block/roots.js";
import type {
  BlockActionSite,
  BlockBoundarySite,
  BlockDefinitionSite,
  Placement
} from "#ir/block/timeline.js";
import type {
  ExprGraph,
  ExprNodeId
} from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";

export type ValueSiteInput = Readonly<{
  graph: ExprGraph;
  roots: readonly BlockRoot[];
}>;

export type BaseValueSite = Readonly<{
  key: ExprNodeId;
  expr: ExprRef;
  root: BlockRoot;
  at: Placement;
  deps: ExprDeps;
}>;

export type ActionInputValueSite = BaseValueSite & Readonly<{
  kind: "actionInput";
  site: BlockActionSite;
  input: "address" | "value" | "index" | "condition" | "target" | "vector";
  direction?: "taken" | "notTaken";
}>;

export type DefinitionInputValueSite = BaseValueSite & Readonly<{
  kind: "definitionInput";
  site: BlockDefinitionSite;
  input: "address" | "index";
}>;

export type BoundaryCellValueSite = BaseValueSite & Readonly<{
  kind: "boundaryCell";
  site: BlockBoundarySite;
  boundary: "stateSync" | "exitState";
  cell: BoundaryRootCellSource;
}>;

export type ValueSite =
  | ActionInputValueSite
  | DefinitionInputValueSite
  | BoundaryCellValueSite;

export function valueSitesForRoots(input: ValueSiteInput): readonly ValueSite[] {
  const sites: ValueSite[] = [];

  for (const root of input.roots) {
    if (boundaryRootIsPassthrough(root)) {
      continue;
    }

    sites.push(valueSiteForRoot(input.graph, root));
  }

  return Object.freeze(sites);
}

function valueSiteForRoot(
  graph: ExprGraph,
  root: BlockRoot
): ValueSite {
  const base = baseValueSite(graph, root);

  switch (root.purpose.kind) {
    case "actionInput": {
      if (root.site.kind !== "action") {
        throw new Error("action-input value site root must reference an action site");
      }

      const site = {
        ...base,
        kind: "actionInput",
        site: root.site,
        input: root.purpose.input,
        ...(root.purpose.direction === undefined ? {} : { direction: root.purpose.direction })
      } satisfies ActionInputValueSite;

      return Object.freeze(site);
    }
    case "definitionInput":
      if (root.site.kind !== "definition") {
        throw new Error("definition-input value site root must reference a definition site");
      }

      return Object.freeze({
        ...base,
        kind: "definitionInput",
        site: root.site,
        input: root.purpose.input
      } satisfies DefinitionInputValueSite);
    case "boundaryCell":
      if (root.site.kind !== "boundary") {
        throw new Error("boundary-cell value site root must reference a boundary site");
      }

      return Object.freeze({
        ...base,
        kind: "boundaryCell",
        site: root.site,
        boundary: root.site.boundary.kind,
        cell: root.purpose.cell
      } satisfies BoundaryCellValueSite);
  }
}

function baseValueSite(
  graph: ExprGraph,
  root: BlockRoot
): BaseValueSite {
  return Object.freeze({
    key: graph.node(root.expr).id,
    expr: root.expr,
    root,
    at: root.at,
    deps: exprDepsForRoot(root)
  });
}

function boundaryRootIsPassthrough(root: BlockRoot): boolean {
  if (root.purpose.kind !== "boundaryCell") {
    return false;
  }

  if (root.site.kind !== "boundary") {
    throw new Error("boundary-cell value site root must reference a boundary site");
  }

  const expr = root.expr;
  const cell = root.purpose.cell;

  if (expr.kind !== "input" || expr.source.kind !== cell.kind) {
    return false;
  }

  switch (cell.kind) {
    case "reg":
      return expr.source.kind === "reg" && expr.source.reg === cell.reg;
    case "flag":
      return expr.source.kind === "flag" && expr.source.flag === cell.flag;
  }
}
