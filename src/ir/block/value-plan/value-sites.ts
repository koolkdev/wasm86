import {
  exprDepsForRoot,
  type ExprDeps
} from "#ir/block/expr-deps.js";
import type {
  BlockRoot,
  BoundaryRootCellSource
} from "#ir/block/roots.js";
import type {
  BlockSchedule,
  BlockScheduleEntryIndex,
  BlockScheduleEntry,
  DefinitionScheduleEntry,
  Placement
} from "#ir/block/schedule.js";
import type {
  ExprGraph,
  ExprNodeId
} from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";

export type ValueSiteInput = Readonly<{
  schedule: BlockSchedule;
  graph: ExprGraph;
  roots: readonly BlockRoot[];
}>;

export type BaseValueSite = Readonly<{
  key: ExprNodeId;
  expr: ExprRef;
  root: BlockRoot;
  entryIndex: BlockScheduleEntryIndex;
  at: Placement;
  deps: ExprDeps;
}>;

export type ActionInputValueSite = BaseValueSite & Readonly<{
  kind: "actionInput";
  entry: Extract<BlockScheduleEntry, { role: "action" }>;
  input: "address" | "value" | "index" | "condition" | "target" | "vector";
  direction?: "taken" | "notTaken";
}>;

export type DefinitionInputValueSite = BaseValueSite & Readonly<{
  kind: "definitionInput";
  entry: DefinitionScheduleEntry;
  input: "address" | "index";
}>;

export type BoundaryCellValueSite = BaseValueSite & Readonly<{
  kind: "boundaryCell";
  entry: Extract<BlockScheduleEntry, { role: "boundary" }>;
  boundary: "stateSync" | "exitState";
  cell: BoundaryRootCellSource;
}>;

export type ValueSite =
  | ActionInputValueSite
  | DefinitionInputValueSite
  | BoundaryCellValueSite;

export function valueSitesForRoots(input: ValueSiteInput): readonly ValueSite[] {
  const entryIndexByEntry = entryIndexMap(input.schedule);
  const sites: ValueSite[] = [];

  for (const root of input.roots) {
    const entryIndex = entryIndexFor(entryIndexByEntry, root.entry);

    if (boundaryRootIsPassthrough(root)) {
      continue;
    }

    sites.push(valueSiteForRoot(input.graph, root, entryIndex));
  }

  return Object.freeze(sites);
}

function valueSiteForRoot(
  graph: ExprGraph,
  root: BlockRoot,
  entryIndex: BlockScheduleEntryIndex
): ValueSite {
  const base = baseValueSite(graph, root, entryIndex);

  switch (root.purpose.kind) {
    case "actionInput": {
      if (root.entry.role !== "action") {
        throw new Error("action-input value site root must reference an action entry");
      }

      const site = {
        ...base,
        kind: "actionInput",
        entry: root.entry,
        input: root.purpose.input,
        ...(root.purpose.direction === undefined ? {} : { direction: root.purpose.direction })
      } satisfies ActionInputValueSite;

      return Object.freeze(site);
    }
    case "definitionInput":
      if (root.entry.role !== "definition") {
        throw new Error("definition-input value site root must reference a definition entry");
      }

      return Object.freeze({
        ...base,
        kind: "definitionInput",
        entry: root.entry,
        input: root.purpose.input
      } satisfies DefinitionInputValueSite);
    case "boundaryCell":
      if (root.entry.role !== "boundary") {
        throw new Error("boundary-cell value site root must reference a boundary entry");
      }

      return Object.freeze({
        ...base,
        kind: "boundaryCell",
        entry: root.entry,
        boundary: root.entry.kind,
        cell: root.purpose.cell
      } satisfies BoundaryCellValueSite);
  }
}

function baseValueSite(
  graph: ExprGraph,
  root: BlockRoot,
  entryIndex: BlockScheduleEntryIndex
): BaseValueSite {
  return Object.freeze({
    key: graph.node(root.expr).id,
    expr: root.expr,
    root,
    entryIndex,
    at: root.at,
    deps: exprDepsForRoot(root)
  });
}

function boundaryRootIsPassthrough(root: BlockRoot): boolean {
  if (root.purpose.kind !== "boundaryCell") {
    return false;
  }

  if (root.entry.role !== "boundary") {
    throw new Error("boundary-cell value site root must reference a boundary entry");
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

function entryIndexMap(schedule: BlockSchedule): ReadonlyMap<BlockScheduleEntry, BlockScheduleEntryIndex> {
  const entryIndexByEntry = new Map<BlockScheduleEntry, BlockScheduleEntryIndex>();

  for (const [index, entry] of schedule.entries()) {
    if (!entryIndexByEntry.has(entry)) {
      entryIndexByEntry.set(entry, index as BlockScheduleEntryIndex);
    }
  }

  return entryIndexByEntry;
}

function entryIndexFor(
  entryIndexByEntry: ReadonlyMap<BlockScheduleEntry, BlockScheduleEntryIndex>,
  entry: BlockScheduleEntry
): BlockScheduleEntryIndex {
  const entryIndex = entryIndexByEntry.get(entry);

  if (entryIndex === undefined) {
    throw new Error("value site root entry is not present in the schedule");
  }

  return entryIndex;
}
