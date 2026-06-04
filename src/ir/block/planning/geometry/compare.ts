import { comparePlacement } from "#ir/block/timeline.js";
import type {
  EdgePath,
  Path,
  ProgramPoint,
  ProgramPointPhase
} from "./types.js";

const PHASE_ORDER: Readonly<Record<ProgramPointPhase, number>> = Object.freeze({
  before: 0,
  at: 1,
  after: 2
});

/**
 * Provides deterministic ordering only; this is not a dominance or availability check.
 */
export function compareProgramPoints(left: ProgramPoint, right: ProgramPoint): number {
  const placementOrder = comparePlacement(left.at, right.at);

  if (placementOrder !== 0) {
    return placementOrder;
  }

  const phaseOrder = PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase];

  return phaseOrder === 0
    ? comparePathOrder(left.path, right.path)
    : phaseOrder;
}

export function programPointsEqual(left: ProgramPoint, right: ProgramPoint): boolean {
  return left.phase === right.phase &&
    comparePlacement(left.at, right.at) === 0 &&
    left.path === right.path;
}

/**
 * Provides deterministic ordering only. A zero result does not mean both paths
 * are the same path-tree object.
 */
export function comparePathOrder(left: Path, right: Path): number {
  const kindOrder = pathKindOrder(left) - pathKindOrder(right);

  if (kindOrder !== 0) {
    return kindOrder;
  }

  switch (left.kind) {
    case "main":
      return 0;
    case "edge":
      return left.edge - (right as EdgePath).edge;
  }
}

function pathKindOrder(path: Path): number {
  switch (path.kind) {
    case "main":
      return 0;
    case "edge":
      return 1;
  }
}
