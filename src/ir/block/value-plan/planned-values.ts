import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type { ExprDeps } from "#ir/block/expr-deps.js";
import {
  mergeSourceCells
} from "#ir/block/source-cells.js";
import type { ExprNodeId } from "#ir/expr/graph/index.js";
import type { ValueSite } from "./value-sites.js";
import type {
  PlannedLifetime,
  PlannedValue,
  PlannedValueId
} from "./types.js";

export function planValues(sites: readonly ValueSite[]): readonly PlannedValue[] {
  const sitesByKey = groupSitesByKey(sites);
  const values: PlannedValue[] = [];

  for (const [key, valueSites] of sitesByKey) {
    const firstSite = valueSites[0];

    if (firstSite === undefined) {
      throw new Error(`planned value group is empty: ${key}`);
    }

    values.push(Object.freeze({
      id: plannedValueId(values.length),
      key,
      expr: firstSite.expr,
      sites: Object.freeze([...valueSites]),
      deps: depsForSites(valueSites),
      lifetime: lifetimeForSites(valueSites)
    }));
  }

  return Object.freeze(values);
}

function groupSitesByKey(sites: readonly ValueSite[]): ReadonlyMap<ExprNodeId, ValueSite[]> {
  const groups = new Map<ExprNodeId, ValueSite[]>();

  for (const site of sites) {
    const group = groups.get(site.key);

    if (group === undefined) {
      groups.set(site.key, [site]);
    } else {
      group.push(site);
    }
  }

  return groups;
}

function depsForSites(sites: readonly ValueSite[]): ExprDeps {
  return Object.freeze({
    sourceCells: mergeSourceCells(sites.flatMap((site) => site.deps.sourceCells)),
    definitionIds: dedupeDefinitionIds(sites)
  });
}

function dedupeDefinitionIds(sites: readonly ValueSite[]): readonly BlockDefinitionId[] {
  const ids = new Set<BlockDefinitionId>();

  for (const site of sites) {
    for (const id of site.deps.definitionIds) {
      ids.add(id);
    }
  }

  return Object.freeze([...ids]);
}

function lifetimeForSites(sites: readonly ValueSite[]): PlannedLifetime {
  const firstSite = sites[0];

  if (firstSite === undefined) {
    throw new Error("planned value lifetime requires at least one site");
  }

  let firstEntry = firstSite.entryIndex;
  let lastEntry = firstSite.entryIndex;

  for (const site of sites) {
    if (site.entryIndex < firstEntry) {
      firstEntry = site.entryIndex;
    }

    if (site.entryIndex > lastEntry) {
      lastEntry = site.entryIndex;
    }
  }

  return Object.freeze({
    firstEntry,
    lastEntry
  });
}

function plannedValueId(value: number): PlannedValueId {
  return value as PlannedValueId;
}
