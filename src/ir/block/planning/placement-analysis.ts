import {
  latestBlockingBarrierBeforeStateWrite,
  type Barrier,
  type BarrierFacts
} from "./barrier-facts.js";
import {
  compareProgramPoints,
  pathCovers,
  type Path,
  type ProgramPoint,
  type TimelineGeometry
} from "./geometry/index.js";
import type {
  EquivalentStateWriteGroup,
  PlannedStateWrite,
  StateWriteId,
  StateWritePlan
} from "./state-writes.js";
import type {
  ValueSnapshot,
  ValueSnapshotId,
  ValuePlan
} from "./values/index.js";

export type PlacementPlan = Readonly<{
  snapshots: readonly ValueSnapshotPlacement[];
  stateWrites: readonly StateWritePlacement[];
}>;

export type ValueSnapshotPlacement = Readonly<{
  snapshot: ValueSnapshotId;
  point: ProgramPoint;
}>;

export type StateWritePlacement = Readonly<{
  representativeWrite: StateWriteId;
  covers: readonly StateWriteId[];
  point: ProgramPoint;
}>;

export type PlacementPlanInput = Readonly<{
  geometry: TimelineGeometry;
  facts: BarrierFacts;
  values: ValuePlan;
  stateWrites: StateWritePlan;
}>;

export function analyzePlacementPlan(input: PlacementPlanInput): PlacementPlan {
  return new PlacementPlanAnalyzer(input).analyze();
}

type StateWritePlacementGroup = Readonly<{
  representative: PlannedStateWrite;
  writes: readonly PlannedStateWrite[];
  neededExitPaths: ReadonlySet<Path>;
  blockers: readonly WriteNeedBlocker[];
}>;

type WriteNeedBlocker = Readonly<{
  write: PlannedStateWrite;
  barrier: Barrier | undefined;
}>;

class PlacementPlanAnalyzer {
  readonly #geometry: TimelineGeometry;
  readonly #facts: BarrierFacts;
  readonly #values: ValuePlan;
  readonly #writeGroups: readonly EquivalentStateWriteGroup[];

  constructor(input: PlacementPlanInput) {
    this.#geometry = input.geometry;
    this.#facts = input.facts;
    this.#values = input.values;
    this.#writeGroups = input.stateWrites.groups;
  }

  analyze(): PlacementPlan {
    return Object.freeze({
      snapshots: Object.freeze(this.#snapshotPlacements()),
      stateWrites: Object.freeze(this.#placeStateWriteGroups())
    } satisfies PlacementPlan);
  }

  #snapshotPlacements(): readonly ValueSnapshotPlacement[] {
    return this.#values.snapshots.map((snapshot) => snapshotPlacement(snapshot));
  }

  #placeStateWriteGroups(): readonly StateWritePlacement[] {
    return this.#writeGroups.flatMap((group) =>
      this.#placeStateWriteGroup(this.#prepareGroup(group))
    );
  }

  #prepareGroup(group: EquivalentStateWriteGroup): StateWritePlacementGroup {
    return Object.freeze({
      representative: group.representative,
      writes: group.writes,
      neededExitPaths: exitPathsForGroup(group.writes),
      blockers: Object.freeze(group.writes.map((write) => Object.freeze({
        write,
        barrier: latestBlockingBarrierBeforeStateWrite(this.#facts, write.target, write.point)
      } satisfies WriteNeedBlocker)))
    } satisfies StateWritePlacementGroup);
  }

  #placeStateWriteGroup(group: StateWritePlacementGroup): readonly StateWritePlacement[] {
    const sharedPoint = this.#latestSharedWritePoint(group);

    if (sharedPoint !== undefined) {
      return [writeStatePlacement(group.representative, group.writes, sharedPoint)];
    }

    return group.writes.map((write) => writeStatePlacement(write, [write], write.point));
  }

  #latestSharedWritePoint(group: StateWritePlacementGroup): ProgramPoint | undefined {
    if (group.neededExitPaths.size < 2) {
      return undefined;
    }

    let latest: ProgramPoint | undefined;

    for (const sitePoints of this.#geometry.points.bySite.values()) {
      const point = sitePoints.before;

      if (
        this.#canShareWriteAt(point, group) &&
        (
          latest === undefined ||
          compareProgramPoints(latest, point) < 0
        )
      ) {
        latest = point;
      }
    }

    return latest;
  }

  #canShareWriteAt(point: ProgramPoint, group: StateWritePlacementGroup): boolean {
    return group.writes.every((write) => this.#coversWriteNeed(point, write)) &&
      this.#coversOnlyNeededExits(point, group.neededExitPaths) &&
      group.blockers.every((blocker) => this.#writeNeedAllowsPlacementAt(point, blocker));
  }

  #coversWriteNeed(point: ProgramPoint, write: PlannedStateWrite): boolean {
    return this.#pointCoversPoint(point, write.point);
  }

  #pointCoversPoint(candidate: ProgramPoint, observed: ProgramPoint): boolean {
    return pathCovers(this.#geometry.paths, candidate.path, observed.path) &&
      compareProgramPoints(candidate, observed) <= 0;
  }

  #coversOnlyNeededExits(
    point: ProgramPoint,
    neededExitPaths: ReadonlySet<Path>
  ): boolean {
    for (const exitPoint of this.#geometry.exits.points) {
      if (
        this.#pointCoversPoint(point, exitPoint.point) &&
        !neededExitPaths.has(exitPoint.path)
      ) {
        return false;
      }
    }

    return true;
  }

  #writeNeedAllowsPlacementAt(point: ProgramPoint, blocker: WriteNeedBlocker): boolean {
    return blocker.barrier === undefined ||
      compareProgramPoints(blocker.barrier.effectPoint, point) <= 0;
  }
}

function snapshotPlacement(snapshot: ValueSnapshot): ValueSnapshotPlacement {
  return Object.freeze({
    snapshot: snapshot.id,
    point: snapshot.establishAt
  } satisfies ValueSnapshotPlacement);
}

function writeStatePlacement(
  representative: PlannedStateWrite,
  covers: readonly PlannedStateWrite[],
  point: ProgramPoint
): StateWritePlacement {
  return Object.freeze({
    representativeWrite: representative.id,
    covers: Object.freeze(covers.map((write) => write.id)),
    point
  } satisfies StateWritePlacement);
}

function exitPathsForGroup(group: readonly PlannedStateWrite[]): ReadonlySet<Path> {
  const paths = new Set<Path>();

  for (const write of group) {
    if (write.point.path.kind !== "main") {
      paths.add(write.point.path);
    }
  }

  return paths;
}
