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
  BranchArm,
  BranchPath,
  DefinitionPoint,
  ExitPath,
  ExitPoint,
  MainPath,
  MemoryGuardPoint,
  MemoryWritePoint,
  Path,
  PathEdge,
  ProgramPoint,
  ProgramPointPhase,
  RegisterGeometry,
  SitePoints,
  TimelineGeometry,
  TimelineGeometryInput
} from "./types.js";

export function buildTimelineGeometry(input: TimelineGeometryInput): TimelineGeometry {
  const mainPath = Object.freeze({ kind: "main" } satisfies MainPath);
  const edges: PathEdge[] = [];
  const parentByPath = new Map<Path, Path>();
  const pointsBySite = new Map<BlockTimelineSite, SitePoints>();
  const exitPoints: ExitPoint[] = [];
  const exitByExit = new Map<BlockExitId, ExitPoint>();
  const definitionPoints: DefinitionPoint[] = [];
  const definitionByDefinition = new Map<DefinitionPoint["definition"]["id"], DefinitionPoint>();
  const memoryWritePoints: MemoryWritePoint[] = [];
  const memoryGuardPoints: MemoryGuardPoint[] = [];
  const dynamicRegisterStorePoints: RegisterGeometry["dynamicStores"][number][] = [];
  const inputExitIds = new Set(input.exits.map((exit) => exit.id));
  const seenExitIds = new Set<BlockExitId>();

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
        const faultPath = createExitPath(site.action.faultExit);
        const faultExitPoint = addExitPoint({
          exit: site.action.faultExit,
          path: faultPath,
          site,
          at: site.at,
          inputExitIds,
          seenExitIds,
          exitPoints,
          exitByExit
        });

        addPathEdge(edges, parentByPath, mainPath, faultPath);
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
        const exitPath = createExitPath(site.action.exit);

        addPathEdge(edges, parentByPath, mainPath, exitPath);
        addExitPoint({
          exit: site.action.exit,
          path: exitPath,
          site,
          at: site.at,
          inputExitIds,
          seenExitIds,
          exitPoints,
          exitByExit
        });
        break;
      }
      case "branch": {
        const takenPath = createBranchPath(site.at, "taken");
        const notTakenPath = createBranchPath(site.at, "notTaken");

        addPathEdge(edges, parentByPath, mainPath, takenPath);
        addPathEdge(edges, parentByPath, mainPath, notTakenPath);
        addExitPoint({
          exit: site.action.taken,
          path: takenPath,
          site,
          at: site.at,
          inputExitIds,
          seenExitIds,
          exitPoints,
          exitByExit
        });
        addExitPoint({
          exit: site.action.notTaken,
          path: notTakenPath,
          site,
          at: site.at,
          inputExitIds,
          seenExitIds,
          exitPoints,
          exitByExit
        });
        break;
      }
    }
  }

  for (const exit of input.exits) {
    if (!seenExitIds.has(exit.id)) {
      throw new Error(`block exit ${exit.id} has no source timeline action`);
    }
  }

  return Object.freeze({
    paths: Object.freeze({
      root: mainPath,
      edges: Object.freeze([...edges]),
      parentByPath: Object.freeze(new Map(parentByPath))
    }),
    points: Object.freeze({
      bySite: Object.freeze(pointsBySite)
    }),
    exits: Object.freeze({
      points: Object.freeze([...exitPoints]),
      byExit: Object.freeze(new Map(exitByExit))
    }),
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

function addExitPoint(input: Readonly<{
  exit: BlockExit;
  path: Path;
  site: BlockActionSite;
  at: Placement;
  inputExitIds: ReadonlySet<BlockExitId>;
  seenExitIds: Set<BlockExitId>;
  exitPoints: ExitPoint[];
  exitByExit: Map<BlockExitId, ExitPoint>;
}>): ExitPoint {
  if (!input.inputExitIds.has(input.exit.id)) {
    throw new Error(`timeline action references unknown block exit ${input.exit.id}`);
  }

  if (input.seenExitIds.has(input.exit.id)) {
    throw new Error(`block exit ${input.exit.id} is referenced by multiple timeline actions`);
  }

  input.seenExitIds.add(input.exit.id);

  const point = Object.freeze({
    path: input.path,
    at: input.at,
    phase: "at"
  } satisfies ProgramPoint);
  const exitPoint = Object.freeze({
    exit: input.exit,
    path: input.path,
    point,
    sourceSite: input.site
  } satisfies ExitPoint);

  input.exitPoints.push(exitPoint);
  input.exitByExit.set(input.exit.id, exitPoint);
  return exitPoint;
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

function createBranchPath(at: Placement, arm: BranchArm): BranchPath {
  return Object.freeze({
    kind: "branch",
    at,
    arm
  });
}

function createExitPath(exit: BlockExit): ExitPath {
  return Object.freeze({
    kind: "exit",
    exit: exit.id,
    exitKind: exit.kind
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
