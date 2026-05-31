import {
  sourceCellsOverlap,
  type SourceCell
} from "#ir/block/source-cells.js";
import {
  type CellObservation,
  type Path,
  programPointBefore,
  type ProgramPoint,
  type ReadBarrier,
  type SourceBarrierSource,
  type TimelineConstraints
} from "./constraints.js";

type RegisterCellKey = Extract<SourceCell, { kind: "reg" }>["reg"]["base"];
type FlagCellKey = Extract<SourceCell, { kind: "flag" }>["flag"];
type DefinitionReplayBarrierKey = Readonly<Extract<ReadBarrier["domain"], { kind: "definitionReplay" }>["domain"]>["kind"];

type SourceCellIndex<T> = Readonly<{
  registers: ReadonlyMap<RegisterCellKey, readonly T[]>;
  flags: ReadonlyMap<FlagCellKey, readonly T[]>;
}>;

type ReadBarrierIndex = Readonly<{
  registerScope: readonly ReadBarrier[];
  sources: SourceCellIndex<ReadBarrier>;
  definitionReplay: ReadonlyMap<DefinitionReplayBarrierKey, readonly ReadBarrier[]>;
}>;

type PathAncestry = Readonly<{
  paths: readonly Path[];
  indexesByKey: ReadonlyMap<string, number>;
  ancestorIndexesByPathIndex: readonly ReadonlySet<number>[];
}>;

export type ConstraintIndex = Readonly<{
  constraints: TimelineConstraints;
  pathAncestry: PathAncestry;
  readBarriers: ReadBarrierIndex;
  observationsByCell: SourceCellIndex<CellObservation>;
}>;

export function buildConstraintIndex(
  constraints: TimelineConstraints
): ConstraintIndex {
  return Object.freeze({
    constraints,
    pathAncestry: buildPathAncestry(constraints.paths.root, constraints.paths.edges),
    readBarriers: indexReadBarriers(constraints.readBarriers),
    observationsByCell: indexCellItems(constraints.cellObservations)
  } satisfies ConstraintIndex);
}

export function pathCoversInConstraints(
  index: ConstraintIndex,
  candidate: Path,
  observed: Path
): boolean {
  const candidateIndex = pathIndex(index.pathAncestry, candidate);
  const observedIndex = pathIndex(index.pathAncestry, observed);

  if (candidateIndex === undefined || observedIndex === undefined) {
    return false;
  }

  return index.pathAncestry.ancestorIndexesByPathIndex[observedIndex]?.has(candidateIndex) ?? false;
}

export function cellObservationsForCell(
  index: ConstraintIndex,
  cell: SourceCell
): readonly CellObservation[] {
  return indexedCellItems(index.observationsByCell, cell).filter((observation) =>
    sourceCellsOverlap(observation.cell, cell)
  );
}

export function coveredCellObservations(
  index: ConstraintIndex,
  cell: SourceCell,
  at: ProgramPoint
): readonly CellObservation[] {
  return Object.freeze(cellObservationsForCell(index, cell).filter((observation) =>
    pathCoversInConstraints(index, at.path, observation.point.path) &&
      !programPointBefore(observation.point, at)
  ));
}

export function sourceReadBarriersForCell(
  index: ConstraintIndex,
  source: SourceCell
): readonly ReadBarrier[] {
  const barriers = [...indexedCellItems(index.readBarriers.sources, source)];

  if (source.kind === "reg") {
    barriers.push(...index.readBarriers.registerScope);
  }

  return Object.freeze(barriers.filter((barrier) =>
    barrier.domain.kind === "source" &&
      sourceBarrierMatches(barrier.domain.source, source)
  ));
}

export function definitionReplayBarriersForDomain(
  index: ConstraintIndex,
  domain: DefinitionReplayBarrierKey
): readonly ReadBarrier[] {
  return index.readBarriers.definitionReplay.get(domain) ?? Object.freeze([]);
}

function buildPathAncestry(
  root: Path,
  edges: readonly Readonly<{ parent: Path; child: Path }>[]
): PathAncestry {
  const paths: Path[] = [];
  const indexesByKey = new Map<string, number>();
  const parentByChild = new Map<number, number>();

  const indexFor = (path: Path): number => {
    const key = pathKey(path);
    const existing = indexesByKey.get(key);

    if (existing !== undefined) {
      return existing;
    }

    paths.push(path);
    indexesByKey.set(key, paths.length - 1);
    return paths.length - 1;
  };

  indexFor(root);

  for (const edge of edges) {
    const parent = indexFor(edge.parent);
    const child = indexFor(edge.child);

    parentByChild.set(child, parent);
  }

  return Object.freeze({
    paths: Object.freeze([...paths]),
    indexesByKey: new Map(indexesByKey),
    ancestorIndexesByPathIndex: Object.freeze(paths.map((_, index) => ancestorsForPath(index, parentByChild)))
  });
}

function ancestorsForPath(
  pathIndex: number,
  parentByChild: ReadonlyMap<number, number>
): ReadonlySet<number> {
  const ancestors = new Set<number>();

  for (
    let current: number | undefined = pathIndex;
    current !== undefined;
    current = parentByChild.get(current)
  ) {
    ancestors.add(current);
  }

  return ancestors;
}

function pathIndex(
  ancestry: PathAncestry,
  path: Path
): number | undefined {
  return ancestry.indexesByKey.get(pathKey(path));
}

function pathKey(path: Path): string {
  switch (path.kind) {
    case "root":
      return "root";
    case "branch":
      return `branch:${path.at.opIndex}:${path.at.epoch}:${path.arm}`;
    case "exit":
      return `exit:${path.exit}:${path.exitKind}`;
  }
}

function indexReadBarriers(
  barriers: readonly ReadBarrier[]
): ReadBarrierIndex {
  const registerScope: ReadBarrier[] = [];
  const sources: ReadBarrier[] = [];
  const definitionReplay = new Map<DefinitionReplayBarrierKey, ReadBarrier[]>();

  for (const barrier of barriers) {
    switch (barrier.domain.kind) {
      case "source":
        if (barrier.domain.source.kind === "registerScope") {
          registerScope.push(barrier);
        } else {
          sources.push(barrier);
        }
        break;
      case "definitionReplay":
        appendIndexedItem(definitionReplay, barrier.domain.domain.kind, barrier);
        break;
    }
  }

  return Object.freeze({
    registerScope: Object.freeze([...registerScope]),
    sources: indexSourceBarriers(sources),
    definitionReplay: freezeIndex(definitionReplay)
  });
}

function indexSourceBarriers(
  barriers: readonly ReadBarrier[]
): SourceCellIndex<ReadBarrier> {
  const registers = new Map<RegisterCellKey, ReadBarrier[]>();
  const flags = new Map<FlagCellKey, ReadBarrier[]>();

  for (const barrier of barriers) {
    if (barrier.domain.kind !== "source" || barrier.domain.source.kind === "registerScope") {
      continue;
    }

    switch (barrier.domain.source.kind) {
      case "reg":
        appendIndexedItem(registers, barrier.domain.source.reg.base, barrier);
        break;
      case "flag":
        appendIndexedItem(flags, barrier.domain.source.flag, barrier);
        break;
    }
  }

  return Object.freeze({
    registers: freezeIndex(registers),
    flags: freezeIndex(flags)
  });
}

function sourceBarrierMatches(
  barrier: SourceBarrierSource,
  source: SourceCell
): boolean {
  if (barrier.kind === "registerScope") {
    return source.kind === "reg";
  }

  return sourceCellsOverlap(barrier, source);
}

function indexCellItems<T extends { readonly cell: SourceCell }>(
  items: readonly T[]
): SourceCellIndex<T> {
  const registers = new Map<RegisterCellKey, T[]>();
  const flags = new Map<FlagCellKey, T[]>();

  for (const item of items) {
    switch (item.cell.kind) {
      case "reg":
        appendIndexedItem(registers, item.cell.reg.base, item);
        break;
      case "flag":
        appendIndexedItem(flags, item.cell.flag, item);
        break;
    }
  }

  return Object.freeze({
    registers: freezeIndex(registers),
    flags: freezeIndex(flags)
  });
}

function indexedCellItems<T>(
  index: SourceCellIndex<T>,
  cell: SourceCell
): readonly T[] {
  switch (cell.kind) {
    case "reg":
      return index.registers.get(cell.reg.base) ?? Object.freeze([]);
    case "flag":
      return index.flags.get(cell.flag) ?? Object.freeze([]);
  }
}

function appendIndexedItem<Key, T>(
  index: Map<Key, T[]>,
  key: Key,
  item: T
): void {
  const items = index.get(key);

  if (items === undefined) {
    index.set(key, [item]);
  } else {
    items.push(item);
  }
}

function freezeIndex<Key, T>(
  index: ReadonlyMap<Key, readonly T[]>
): ReadonlyMap<Key, readonly T[]> {
  const frozen = new Map<Key, readonly T[]>();

  for (const [key, items] of index.entries()) {
    frozen.set(key, Object.freeze([...items]));
  }

  return frozen;
}
