import type { BlockDefinitionId } from "#ir/block/definitions.js";
import {
  blockingBarrierForDefinitionReplay,
  type Barrier,
  type BarrierFacts,
  type DefinitionResult
} from "#ir/block/planning/barrier-facts.js";
import {
  compareProgramPoints,
  pathCovers,
  type Path,
  type ProgramPoint
} from "#ir/block/planning/geometry/index.js";
import type { TimelineGeometry } from "#ir/block/planning/geometry/index.js";
import type { ExprInputSource } from "#ir/expr/types.js";
import type { SaveReason } from "./types.js";

export type SaveBlocker = Readonly<{
  barrier: Barrier;
  saveAt: ProgramPoint;
  reason: SaveReason;
}>;

type CachedBlocker = SaveBlocker | null;
type BarrierPathIndex = ReadonlyMap<Path, readonly Barrier[]>;

export class ValueBarrierIndex {
  readonly #facts: BarrierFacts;
  readonly #geometry: TimelineGeometry;
  readonly #definitions = new Map<BlockDefinitionId, DefinitionResult>();
  readonly #dynamicRegisterBarriersByPath: BarrierPathIndex;
  readonly #sourceRegisterBlockerByUse = new Map<ProgramPoint, CachedBlocker>();
  readonly #definitionReplayBlockerByUse = new Map<BlockDefinitionId, Map<ProgramPoint, CachedBlocker>>();

  constructor(input: Readonly<{
    facts: BarrierFacts;
    geometry: TimelineGeometry;
  }>) {
    this.#facts = input.facts;
    this.#geometry = input.geometry;

    for (const definition of input.facts.definitions) {
      this.#definitions.set(definition.id, definition);
    }

    // BarrierFacts preserves effect-point order; these per-path filtered views
    // keep that order for firstBarrierIndexAfter's binary search.
    this.#dynamicRegisterBarriersByPath = indexBarriersByEffectPath(
      input.facts.barriers.filter((barrier) => barrier.kind === "dynamic-register-store")
    );
  }

  definition(id: BlockDefinitionId): DefinitionResult | undefined {
    return this.#definitions.get(id);
  }

  definitionExistsAt(definition: DefinitionResult, point: ProgramPoint): boolean {
    return pathCovers(this.#geometry.paths, definition.point.path, point.path) &&
      compareProgramPoints(definition.point, point) <= 0;
  }

  sourceInputBlocker(source: ExprInputSource, use: ProgramPoint): SaveBlocker | undefined {
    switch (source.kind) {
      case "reg":
        return this.#cachedSourceRegisterBlocker(use);
      case "flag":
      case "def":
        return undefined;
    }
  }

  definitionReplayBlocker(definition: DefinitionResult, use: ProgramPoint): SaveBlocker | undefined {
    let byUse = this.#definitionReplayBlockerByUse.get(definition.id);

    if (byUse === undefined) {
      byUse = new Map();
      this.#definitionReplayBlockerByUse.set(definition.id, byUse);
    }

    if (byUse.has(use)) {
      return byUse.get(use) ?? undefined;
    }

    const blocker = this.#definitionReplayBlocker(definition, use);

    byUse.set(use, blocker ?? null);
    return blocker;
  }

  #definitionReplayBlocker(definition: DefinitionResult, use: ProgramPoint): SaveBlocker | undefined {
    const barrier = blockingBarrierForDefinitionReplay(this.#facts, definition, use);

    if (barrier !== undefined) {
      return Object.freeze({
        barrier,
        saveAt: latestLegalSavePointBeforeBarrier(barrier),
        reason: Object.freeze({
          kind: "definition-replay-barrier",
          domain: definition.domain,
          definition: definition.id,
          barrier
        } satisfies SaveReason)
      } satisfies SaveBlocker);
    }

    return undefined;
  }

  #cachedSourceRegisterBlocker(use: ProgramPoint): SaveBlocker | undefined {
    if (this.#sourceRegisterBlockerByUse.has(use)) {
      return this.#sourceRegisterBlockerByUse.get(use) ?? undefined;
    }

    const blocker = this.#sourceRegisterBlocker(use);

    this.#sourceRegisterBlockerByUse.set(use, blocker ?? null);
    return blocker;
  }

  #sourceRegisterBlocker(use: ProgramPoint): SaveBlocker | undefined {
    const barrier = this.#firstCrossedBarrierAfter(
      this.#dynamicRegisterBarriersByPath,
      undefined,
      use
    );

    if (barrier !== undefined) {
      return Object.freeze({
        barrier,
        saveAt: latestLegalSavePointBeforeBarrier(barrier),
        reason: Object.freeze({
          kind: "source-read-barrier",
          domain: "registers",
          barrier
        } satisfies SaveReason)
      } satisfies SaveBlocker);
    }

    return undefined;
  }

  #firstCrossedBarrierAfter(
    barriersByPath: BarrierPathIndex,
    from: ProgramPoint | undefined,
    use: ProgramPoint
  ): Barrier | undefined {
    return earliestBarrier(coveringPaths(this.#geometry, use.path).map((path) => {
      const barriers = barriersByPath.get(path);

      if (barriers === undefined) {
        return undefined;
      }

      const index = from === undefined
        ? 0
        : firstBarrierIndexAfter(barriers, from);
      const barrier = barriers[index];

      return barrier !== undefined && compareProgramPoints(barrier.effectPoint, use) < 0
        ? barrier
        : undefined;
    }));
  }
}

export function latestLegalSavePointBeforeBarrier(barrier: Barrier): ProgramPoint {
  return barrier.inputPoint;
}

function firstBarrierIndexAfter(
  barriers: readonly Barrier[],
  point: ProgramPoint
): number {
  let low = 0;
  let high = barriers.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const barrier = barriers[mid]!;

    if (compareProgramPoints(barrier.effectPoint, point) <= 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function indexBarriersByEffectPath(barriers: readonly Barrier[]): BarrierPathIndex {
  const mutable = new Map<Path, Barrier[]>();

  for (const barrier of barriers) {
    const path = barrier.effectPoint.path;
    const pathBarriers = mutable.get(path);

    if (pathBarriers === undefined) {
      mutable.set(path, [barrier]);
    } else {
      pathBarriers.push(barrier);
    }
  }

  return Object.freeze(new Map([...mutable].map(([path, pathBarriers]) => [
    path,
    Object.freeze([...pathBarriers])
  ])));
}

function coveringPaths(geometry: TimelineGeometry, path: Path): readonly Path[] {
  const paths: Path[] = [];
  const seen = new Set<Path>();
  let current: Path | undefined = path;

  while (current !== undefined && !seen.has(current)) {
    paths.push(current);
    seen.add(current);
    current = geometry.paths.parentByPath.get(current);
  }

  return paths;
}

function earliestBarrier(barriers: readonly (Barrier | undefined)[]): Barrier | undefined {
  let earliest: Barrier | undefined;

  for (const barrier of barriers) {
    if (barrier === undefined) {
      continue;
    }

    if (
      earliest === undefined ||
      compareProgramPoints(barrier.effectPoint, earliest.effectPoint) < 0
    ) {
      earliest = barrier;
    }
  }

  return earliest;
}
