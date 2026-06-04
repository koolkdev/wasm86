import type {
  BlockExit,
  BlockExitId
} from "#ir/block/exits.js";
import type {
  BlockActionSite,
  BlockTimelineSite,
  Placement
} from "#ir/block/timeline.js";
import type {
  ActionSiteFor,
  BlockEdge,
  BlockEdgeId,
  BlockEdgeKind,
  EdgeGeometry,
  DefinitionPoint,
  EdgePath,
  ExitGeometry,
  ExitPoint,
  MainPath,
  MemoryGuardPoint,
  MemoryWritePoint,
  Path,
  PathEdge,
  PathGeometry,
  ProgramPoint,
  ProgramPointPhase,
  RegisterGeometry,
  SitePoints,
  TimelineGeometry,
  TimelineGeometryInput
} from "./types.js";

export function buildTimelineGeometry(input: TimelineGeometryInput): TimelineGeometry {
  const mainPath = Object.freeze({ kind: "main" } satisfies MainPath);
  const edgeRecorder = new TimelineEdgeRecorder(mainPath, input.exits);
  const pointsBySite = new Map<BlockTimelineSite, SitePoints>();
  const definitionPoints: DefinitionPoint[] = [];
  const definitionByDefinition = new Map<DefinitionPoint["definition"]["id"], DefinitionPoint>();
  const memoryWritePoints: MemoryWritePoint[] = [];
  const memoryGuardPoints: MemoryGuardPoint[] = [];
  const dynamicRegisterStorePoints: RegisterGeometry["dynamicStores"][number][] = [];

  for (const site of input.timeline) {
    const sitePoints = createSitePoints(mainPath, site.at);

    pointsBySite.set(site, sitePoints);

    if (site.kind === "definition") {
      const definitionPoint = Object.freeze({
        definition: site.definition,
        site,
        point: sitePoints.at
      } satisfies DefinitionPoint);

      definitionPoints.push(definitionPoint);
      definitionByDefinition.set(site.definition.id, definitionPoint);
      continue;
    }

    switch (site.action.kind) {
      case "memoryGuard": {
        const faultExitPoint = edgeRecorder.recordExit({
          kind: "memory-fault",
          exit: site.action.faultExit,
          site,
          at: site.at
        });

        memoryGuardPoints.push(Object.freeze({
          site: site as ActionSiteFor<"memoryGuard">,
          point: sitePoints.at,
          faultExitPoint
        }));
        break;
      }
      case "memoryStore":
        memoryWritePoints.push(Object.freeze({
          site: site as ActionSiteFor<"memoryStore">,
          point: sitePoints.at
        }));
        break;
      case "dynamicRegisterStore":
        dynamicRegisterStorePoints.push(Object.freeze({
          site: site as ActionSiteFor<"dynamicRegisterStore">,
          point: sitePoints.at,
          preStatePoint: sitePoints.before
        }));
        break;
      case "jump":
      case "hostTrap":
      case "fallthrough": {
        edgeRecorder.recordExit({
          kind: edgeKindForAction(site.action.kind),
          exit: site.action.exit,
          site,
          at: site.at
        });
        break;
      }
      case "branch": {
        edgeRecorder.recordExit({
          kind: "branch-taken",
          exit: site.action.taken,
          site,
          at: site.at
        });
        edgeRecorder.recordExit({
          kind: "branch-not-taken",
          exit: site.action.notTaken,
          site,
          at: site.at
        });
        break;
      }
    }
  }

  edgeRecorder.assertEveryInputExitWasSeen();

  return Object.freeze({
    paths: edgeRecorder.pathGeometry(),
    edges: edgeRecorder.edgeGeometry(),
    points: Object.freeze({
      bySite: Object.freeze(pointsBySite)
    }),
    exits: edgeRecorder.exitGeometry(),
    definitions: Object.freeze({
      points: Object.freeze([...definitionPoints]),
      byDefinition: Object.freeze(new Map(definitionByDefinition))
    }),
    memory: Object.freeze({
      guards: Object.freeze([...memoryGuardPoints]),
      writes: Object.freeze([...memoryWritePoints])
    }),
    registers: Object.freeze({
      dynamicStores: Object.freeze([...dynamicRegisterStorePoints])
    })
  });
}

class BlockEdgeIds {
  #next = 0;

  next(): BlockEdgeId {
    const id = this.#next;

    this.#next += 1;
    return id as BlockEdgeId;
  }
}

class TimelineEdgeRecorder {
  readonly #root: MainPath;
  readonly #edgeIds = new BlockEdgeIds();
  readonly #pathEdges: PathEdge[] = [];
  readonly #parentByPath = new Map<Path, Path>();
  readonly #blockEdges: BlockEdge[] = [];
  readonly #blockEdgeById = new Map<BlockEdgeId, BlockEdge>();
  readonly #blockEdgeByExit = new Map<BlockExitId, BlockEdge>();
  readonly #blockEdgeByPath = new Map<EdgePath, BlockEdge>();
  readonly #exitPoints: ExitPoint[] = [];
  readonly #exitByExit = new Map<BlockExitId, ExitPoint>();
  readonly #inputExitIds: ReadonlySet<BlockExitId>;
  readonly #seenExitIds = new Set<BlockExitId>();

  constructor(root: MainPath, exits: readonly BlockExit[]) {
    this.#root = root;
    this.#inputExitIds = new Set(exits.map((exit) => exit.id));
  }

  recordExit(input: Readonly<{
    kind: BlockEdgeKind;
    exit: BlockExit;
    site: BlockActionSite;
    at: Placement;
  }>): ExitPoint {
    if (!this.#inputExitIds.has(input.exit.id)) {
      throw new Error(`timeline action references unknown block exit ${input.exit.id}`);
    }

    if (this.#seenExitIds.has(input.exit.id)) {
      throw new Error(`block exit ${input.exit.id} is referenced by multiple timeline actions`);
    }

    this.#seenExitIds.add(input.exit.id);

    const edge = Object.freeze({
      id: this.#edgeIds.next(),
      kind: input.kind,
      sourceSite: input.site,
      exit: input.exit
    } satisfies BlockEdge);
    const path = createEdgePath(edge.id);

    addPathEdge(this.#pathEdges, this.#parentByPath, this.#root, path);

    const point = Object.freeze({
      path,
      at: input.at,
      phase: "at"
    } satisfies ProgramPoint);
    const exitPoint = Object.freeze({
      exit: input.exit,
      edge: edge.id,
      path,
      point,
      sourceSite: input.site
    } satisfies ExitPoint);

    this.#blockEdges.push(edge);
    this.#blockEdgeById.set(edge.id, edge);
    this.#blockEdgeByExit.set(input.exit.id, edge);
    this.#blockEdgeByPath.set(path, edge);
    this.#exitPoints.push(exitPoint);
    this.#exitByExit.set(input.exit.id, exitPoint);
    return exitPoint;
  }

  assertEveryInputExitWasSeen(): void {
    for (const exitId of this.#inputExitIds) {
      if (!this.#seenExitIds.has(exitId)) {
        throw new Error(`block exit ${exitId} has no source timeline action`);
      }
    }
  }

  pathGeometry(): PathGeometry {
    return Object.freeze({
      root: this.#root,
      edges: Object.freeze([...this.#pathEdges]),
      parentByPath: Object.freeze(new Map(this.#parentByPath))
    } satisfies PathGeometry);
  }

  edgeGeometry(): EdgeGeometry {
    return Object.freeze({
      all: Object.freeze([...this.#blockEdges]),
      byId: Object.freeze(new Map(this.#blockEdgeById)),
      byExit: Object.freeze(new Map(this.#blockEdgeByExit)),
      byPath: Object.freeze(new Map(this.#blockEdgeByPath))
    } satisfies EdgeGeometry);
  }

  exitGeometry(): ExitGeometry {
    return Object.freeze({
      points: Object.freeze([...this.#exitPoints]),
      byExit: Object.freeze(new Map(this.#exitByExit))
    } satisfies ExitGeometry);
  }
}

function createSitePoints(path: Path, at: Placement): SitePoints {
  return Object.freeze({
    before: createProgramPoint(path, at, "before"),
    at: createProgramPoint(path, at, "at"),
    after: createProgramPoint(path, at, "after")
  });
}

function createProgramPoint(
  path: Path,
  at: Placement,
  phase: ProgramPointPhase
): ProgramPoint {
  return Object.freeze({
    path,
    at,
    phase
  });
}

function createEdgePath(edge: BlockEdgeId): EdgePath {
  return Object.freeze({
    kind: "edge",
    edge
  });
}

function addPathEdge(
  edges: PathEdge[],
  parentByPath: Map<Path, Path>,
  parent: Path,
  child: Path
): void {
  const edge = Object.freeze({
    parent,
    child
  } satisfies PathEdge);

  edges.push(edge);
  parentByPath.set(child, parent);
}

function edgeKindForAction(kind: "jump" | "hostTrap" | "fallthrough"): BlockEdgeKind {
  switch (kind) {
    case "jump":
      return "jump";
    case "hostTrap":
      return "host-trap";
    case "fallthrough":
      return "fallthrough";
  }
}
