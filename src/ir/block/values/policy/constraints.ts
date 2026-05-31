import { exitsForAction } from "#ir/block/actions.js";
import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type {
  BlockExit,
  BlockExitId
} from "#ir/block/exits.js";
import {
  comparePlacement,
  type BlockDefinitionSite,
  type BlockTimelineSite,
  type Placement
} from "#ir/block/timeline.js";
import {
  sourceCellForFlag,
  sourceCellForRegisterAlias,
  type SourceCell
} from "#ir/block/source-cells.js";
import type { FlagCell } from "#ir/block/state/flag-state.js";
import type { BlockState } from "#ir/block/walk/state.js";
import { exprInput } from "#ir/expr/builders.js";
import type { ExprRef } from "#ir/expr/types.js";
import { registerAlias } from "#x86/registers.js";

export type Path =
  | Readonly<{ kind: "root" }>
  | Readonly<{
      kind: "branch";
      at: Placement;
      arm: "taken" | "notTaken";
    }>
  | Readonly<{
      kind: "exit";
      exit: BlockExitId;
      exitKind: BlockExit["kind"];
    }>;

export type PathEdge = Readonly<{
  parent: Path;
  child: Path;
}>;

export type PathTree = Readonly<{
  root: Path;
  edges: readonly PathEdge[];
}>;

export type PathPoint = Readonly<{
  path: Path;
  at: Placement;
  phase: "before" | "at" | "after";
}>;

export type TimelineConstraintsInput = Readonly<{
  timeline: readonly BlockTimelineSite[];
}>;

export type TimelineConstraints = Readonly<{
  paths: PathTree;
  readBarriers: readonly ReadBarrier[];
  cellValueTargets: readonly CellValueTarget[];
  cellWrites: readonly CellWrite[];
}>;

export type ReadBarrier = Readonly<{
  point: PathPoint;
  domain: ReadBarrierDomain;
  site: BlockTimelineSite;
}>;

export type ReadBarrierDomain =
  | Readonly<{
      kind: "source";
      source: SourceBarrierSource;
    }>
  | Readonly<{
      kind: "definitionReplay";
      domain: DefinitionReplayDomain;
    }>;

export type SourceBarrierSource =
  | SourceCell
  | Readonly<{ kind: "registerScope" }>;

export type DefinitionReplayDomain =
  | Readonly<{ kind: "memory" }>
  | Readonly<{ kind: "registers" }>;

export type CellValueTarget = Readonly<{
  point: PathPoint;
  cell: SourceCell;
  value: ExprRef;
  site: BlockTimelineSite;
}>;

export type CellWrite = Readonly<{
  point: PathPoint;
  cell: SourceCell;
  value: ExprRef;
  site: BlockTimelineSite;
}>;

type TimelineConstraintsMetadata = Readonly<{
  definitions: ReadonlyMap<BlockDefinitionId, BlockDefinitionSite>;
}>;

const metadataForConstraints = new WeakMap<TimelineConstraints, TimelineConstraintsMetadata>();

export function rootPath(): Path {
  return Object.freeze({ kind: "root" });
}

export function branchPath(
  at: Placement,
  arm: "taken" | "notTaken"
): Path {
  return Object.freeze({
    kind: "branch",
    at,
    arm
  });
}

export function exitPath(exit: BlockExit): Path {
  return Object.freeze({
    kind: "exit",
    exit: exit.id,
    exitKind: exit.kind
  });
}

export function pathCovers(
  tree: PathTree,
  candidate: Path,
  observed: Path
): boolean {
  if (pathEquals(candidate, observed)) {
    return true;
  }

  return tree.edges.some((edge) =>
    pathEquals(edge.child, observed) &&
      pathCovers(tree, candidate, edge.parent)
  );
}

export function pathEquals(left: Path, right: Path): boolean {
  switch (left.kind) {
    case "root":
      return right.kind === "root";
    case "branch":
      return right.kind === "branch" &&
        samePlacement(left.at, right.at) &&
        left.arm === right.arm;
    case "exit":
      return right.kind === "exit" &&
        left.exit === right.exit &&
        left.exitKind === right.exitKind;
  }
}

export function pathPoint(
  path: Path,
  at: Placement,
  phase: PathPoint["phase"]
): PathPoint {
  return Object.freeze({
    path,
    at,
    phase
  });
}

export function comparePathPoints(left: PathPoint, right: PathPoint): number {
  const placementOrder = comparePlacement(left.at, right.at);

  return placementOrder === 0
    ? phaseOrder(left.phase) - phaseOrder(right.phase)
    : placementOrder;
}

export function pathPointBefore(left: PathPoint, right: PathPoint): boolean {
  return comparePathPoints(left, right) < 0;
}

export function pathPointAfter(left: PathPoint, right: PathPoint): boolean {
  return comparePathPoints(left, right) > 0;
}

export function pathPointBeforeOrAt(left: PathPoint, right: PathPoint): boolean {
  return comparePathPoints(left, right) <= 0;
}

export function buildTimelineConstraints(
  input: TimelineConstraintsInput
): TimelineConstraints {
  return new TimelineConstraintsBuilder(input.timeline).build();
}

export function definitionSiteForConstraints(
  constraints: TimelineConstraints,
  id: BlockDefinitionId
): BlockDefinitionSite | undefined {
  return metadataForConstraints.get(constraints)?.definitions.get(id);
}

export function pathPointForSite(
  constraints: TimelineConstraints,
  site: BlockTimelineSite,
  phase: PathPoint["phase"]
): PathPoint {
  return pathPoint(constraints.paths.root, site.at, phase);
}

class TimelineConstraintsBuilder {
  readonly #timeline: readonly BlockTimelineSite[];
  readonly #root = rootPath();
  readonly #exitPaths = new Map<BlockExit["id"], Path>();
  readonly #edges: PathEdge[] = [];
  readonly #readBarriers: ReadBarrier[] = [];
  readonly #cellValueTargets: CellValueTarget[] = [];
  readonly #definitions = new Map<BlockDefinitionId, BlockDefinitionSite>();

  constructor(timeline: readonly BlockTimelineSite[]) {
    this.#timeline = timeline;
  }

  build(): TimelineConstraints {
    this.#collectPaths();

    const paths = Object.freeze({
      root: this.#root,
      edges: Object.freeze([...this.#edges])
    } satisfies PathTree);

    this.#collectConstraints(paths);

    const constraints = Object.freeze({
      paths,
      readBarriers: Object.freeze([...this.#readBarriers]),
      cellValueTargets: Object.freeze([...this.#cellValueTargets]),
      cellWrites: Object.freeze([])
    } satisfies TimelineConstraints);

    metadataForConstraints.set(constraints, Object.freeze({
      definitions: new Map(this.#definitions)
    }));

    return constraints;
  }

  #collectPaths(): void {
    for (const site of this.#timeline) {
      if (site.kind !== "action") {
        continue;
      }

      for (const exit of exitsForAction(site.action)) {
        const child = pathForExitSite(site.at, exit);

        this.#exitPaths.set(exit.id, child);
        this.#edges.push(Object.freeze({ parent: this.#root, child }));
      }
    }
  }

  #collectConstraints(paths: PathTree): void {
    for (const site of this.#timeline) {
      switch (site.kind) {
        case "action":
          this.#appendActionConstraints(paths, site);
          break;
        case "definition":
          this.#definitions.set(site.definition.id, site);
          break;
      }
    }
  }

  #appendActionConstraints(
    paths: PathTree,
    site: Extract<BlockTimelineSite, { kind: "action" }>
  ): void {
    switch (site.action.kind) {
      case "dynamicRegisterStore": {
        const point = this.#pointForSite(paths, site, "at");

        this.#readBarriers.push(readBarrier(point, {
          kind: "source",
          source: Object.freeze({ kind: "registerScope" })
        }, site));
        this.#readBarriers.push(readBarrier(point, {
          kind: "definitionReplay",
          domain: Object.freeze({ kind: "registers" })
        }, site));
        appendStateValueTargets(
          this.#cellValueTargets,
          site,
          pathPoint(point.path, site.at, "before"),
          site.action.stateBefore
        );
        return;
      }
      case "memoryStore":
        this.#readBarriers.push(readBarrier(this.#pointForSite(paths, site, "at"), {
          kind: "definitionReplay",
          domain: Object.freeze({ kind: "memory" })
        }, site));
        return;
      case "memoryGuard":
      case "jump":
      case "branch":
      case "hostTrap":
      case "fallthrough":
        break;
    }

    this.#appendExitValueTargets(site);
  }

  #appendExitValueTargets(
    site: Extract<BlockTimelineSite, { kind: "action" }>
  ): void {
    for (const exit of exitsForAction(site.action)) {
      appendStateValueTargets(
        this.#cellValueTargets,
        site,
        pathPoint(this.#exitPaths.get(exit.id) ?? pathForExitSite(site.at, exit), site.at, "at"),
        exit.snapshot
      );
    }
  }

  #pointForSite(
    paths: PathTree,
    site: BlockTimelineSite,
    phase: PathPoint["phase"]
  ): PathPoint {
    return pathPoint(paths.root, site.at, phase);
  }
}

function appendStateValueTargets(
  targets: CellValueTarget[],
  site: BlockTimelineSite,
  point: PathPoint,
  state: BlockState
): void {
  for (const cell of state.registers.cells()) {
    targets.push(cellValueTarget(point, sourceCellForRegisterAlias(registerAlias(cell.reg)), cell.value, site));
  }

  for (const { flag, cell } of state.flags.cells()) {
    const value = exprForFlagCell(cell);

    if (value !== undefined) {
      targets.push(cellValueTarget(point, sourceCellForFlag(flag), value, site));
    }
  }
}

function cellValueTarget(
  point: PathPoint,
  cell: SourceCell,
  value: ExprRef,
  site: BlockTimelineSite
): CellValueTarget {
  return Object.freeze({
    point,
    cell,
    value,
    site
  });
}

function readBarrier(
  point: PathPoint,
  domain: ReadBarrierDomain,
  site: BlockTimelineSite
): ReadBarrier {
  return Object.freeze({
    point,
    domain,
    site
  });
}

function pathForExitSite(
  at: Placement,
  exit: BlockExit
): Path {
  switch (exit.kind) {
    case "branchTaken":
      return branchPath(at, "taken");
    case "branchNotTaken":
      return branchPath(at, "notTaken");
    case "memoryFault":
    case "jump":
    case "hostTrap":
    case "fallthrough":
      return exitPath(exit);
  }
}

function exprForFlagCell(
  cell: FlagCell
): ExprRef | undefined {
  switch (cell.kind) {
    case "expr":
      return cell.value;
    case "input":
      return exprInput({ kind: "flag", flag: cell.flag });
    case "undef":
      return undefined;
  }
}

function phaseOrder(phase: PathPoint["phase"]): number {
  switch (phase) {
    case "before":
      return 0;
    case "at":
      return 1;
    case "after":
      return 2;
  }
}

function samePlacement(left: Placement, right: Placement): boolean {
  return left.opIndex === right.opIndex && left.epoch === right.epoch;
}
