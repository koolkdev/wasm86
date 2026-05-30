import type { BlockBoundarySite } from "#ir/block/timeline.js";
import type {
  BoundaryCellValueSite,
  ValueSite
} from "./value-sites.js";
import type { PlannedBoundary } from "./types.js";

type BoundaryBuilder = {
  site: BlockBoundarySite;
  boundary: "stateSync" | "exitState";
  at: BoundaryCellValueSite["at"];
  sites: BoundaryCellValueSite[];
};

export function planBoundaries(sites: readonly ValueSite[]): readonly PlannedBoundary[] {
  const boundaries = new Map<BlockBoundarySite, BoundaryBuilder>();

  for (const site of sites) {
    if (site.kind !== "boundaryCell") {
      continue;
    }

    const existing = boundaries.get(site.site);

    if (existing === undefined) {
      boundaries.set(site.site, {
        site: site.site,
        boundary: site.boundary,
        at: site.at,
        sites: [site]
      });
    } else {
      existing.sites.push(site);
    }
  }

  return Object.freeze([...boundaries.values()].map((boundary) => Object.freeze({
    site: boundary.site,
    boundary: boundary.boundary,
    at: boundary.at,
    sites: Object.freeze(boundary.sites)
  } satisfies PlannedBoundary)));
}
