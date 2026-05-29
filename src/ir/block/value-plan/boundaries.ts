import type { BlockScheduleEntry } from "#ir/block/schedule.js";
import type {
  BoundaryCellValueSite,
  ValueSite
} from "./value-sites.js";
import type { PlannedBoundary } from "./types.js";

type BoundaryBuilder = {
  entry: Extract<BlockScheduleEntry, { role: "boundary" }>;
  boundary: "stateSync" | "exitState";
  entryIndex: BoundaryCellValueSite["entryIndex"];
  at: BoundaryCellValueSite["at"];
  sites: BoundaryCellValueSite[];
};

export function planBoundaries(sites: readonly ValueSite[]): readonly PlannedBoundary[] {
  const boundaries = new Map<Extract<BlockScheduleEntry, { role: "boundary" }>, BoundaryBuilder>();

  for (const site of sites) {
    if (site.kind !== "boundaryCell") {
      continue;
    }

    const existing = boundaries.get(site.entry);

    if (existing === undefined) {
      boundaries.set(site.entry, {
        entry: site.entry,
        boundary: site.boundary,
        entryIndex: site.entryIndex,
        at: site.at,
        sites: [site]
      });
    } else {
      existing.sites.push(site);
    }
  }

  return Object.freeze([...boundaries.values()].map((boundary) => Object.freeze({
    entry: boundary.entry,
    boundary: boundary.boundary,
    entryIndex: boundary.entryIndex,
    at: boundary.at,
    sites: Object.freeze(boundary.sites)
  } satisfies PlannedBoundary)));
}
