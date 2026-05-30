import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type { ExprDeps } from "#ir/block/expr-deps.js";
import {
  mergeSourceCells
} from "#ir/block/source-cells.js";
import {
  placementAfter,
  placementBefore
} from "#ir/block/timeline.js";
import type { ExprNodeId } from "#ir/expr/graph/index.js";
import type {
  RootValueAnalysis
} from "./root-analysis.js";
import type {
  PlannedLifetime,
  PlannedValue,
  PlannedValueId
} from "./types.js";

export function planValues(analyses: readonly RootValueAnalysis[]): readonly PlannedValue[] {
  const rootsByKey = groupAnalysesByKey(analyses);
  const values: PlannedValue[] = [];

  for (const [key, rootAnalyses] of rootsByKey) {
    const firstAnalysis = rootAnalyses[0];

    if (firstAnalysis === undefined) {
      throw new Error(`planned value group is empty: ${key}`);
    }

    values.push(Object.freeze({
      id: plannedValueId(values.length),
      key,
      expr: firstAnalysis.valueRoot.root.expr,
      roots: Object.freeze(rootAnalyses.map((analysis) => analysis.valueRoot)),
      deps: depsForAnalyses(rootAnalyses),
      lifetime: lifetimeForAnalyses(rootAnalyses)
    }));
  }

  return Object.freeze(values);
}

function groupAnalysesByKey(
  analyses: readonly RootValueAnalysis[]
): ReadonlyMap<ExprNodeId, RootValueAnalysis[]> {
  const groups = new Map<ExprNodeId, RootValueAnalysis[]>();

  for (const analysis of analyses) {
    const group = groups.get(analysis.key);

    if (group === undefined) {
      groups.set(analysis.key, [analysis]);
    } else {
      group.push(analysis);
    }
  }

  return groups;
}

function depsForAnalyses(analyses: readonly RootValueAnalysis[]): ExprDeps {
  return Object.freeze({
    sourceCells: mergeSourceCells(analyses.flatMap((analysis) => analysis.deps.sourceCells)),
    definitionIds: dedupeDefinitionIds(analyses)
  });
}

function dedupeDefinitionIds(analyses: readonly RootValueAnalysis[]): readonly BlockDefinitionId[] {
  const ids = new Set<BlockDefinitionId>();

  for (const analysis of analyses) {
    for (const id of analysis.deps.definitionIds) {
      ids.add(id);
    }
  }

  return Object.freeze([...ids]);
}

function lifetimeForAnalyses(analyses: readonly RootValueAnalysis[]): PlannedLifetime {
  const first = analyses[0];

  if (first === undefined) {
    throw new Error("planned value lifetime requires at least one root");
  }

  let start = first.valueRoot.root.at;
  let end = first.valueRoot.root.at;

  for (const analysis of analyses) {
    const at = analysis.valueRoot.root.at;

    if (placementBefore(at, start)) {
      start = at;
    }

    if (placementAfter(at, end)) {
      end = at;
    }
  }

  return Object.freeze({
    start,
    end
  });
}

function plannedValueId(value: number): PlannedValueId {
  return value as PlannedValueId;
}
