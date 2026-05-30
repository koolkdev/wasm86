import type { BlockBoundarySite } from "#ir/block/timeline.js";
import type { ValueRoot } from "./value-roots.js";
import type { PlannedBoundary } from "./types.js";

type BoundaryBuilder = {
  site: BlockBoundarySite;
  boundary: "stateSync" | "exitState";
  at: ValueRoot["root"]["at"];
  roots: ValueRoot[];
};

export function planBoundaries(roots: readonly ValueRoot[]): readonly PlannedBoundary[] {
  const boundaries = new Map<BlockBoundarySite, BoundaryBuilder>();

  for (const root of roots) {
    if (root.root.purpose.kind !== "boundaryCell") {
      continue;
    }

    if (root.root.site.kind !== "boundary") {
      throw new Error("boundary-cell value root must reference a boundary site");
    }

    const existing = boundaries.get(root.root.site);

    if (existing === undefined) {
      boundaries.set(root.root.site, {
        site: root.root.site,
        boundary: root.root.site.boundary.kind,
        at: root.root.at,
        roots: [root]
      });
    } else {
      existing.roots.push(root);
    }
  }

  return Object.freeze([...boundaries.values()].map((boundary) => Object.freeze({
    site: boundary.site,
    boundary: boundary.boundary,
    at: boundary.at,
    roots: Object.freeze(boundary.roots)
  } satisfies PlannedBoundary)));
}
