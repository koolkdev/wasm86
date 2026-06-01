import type { BlockAction } from "#ir/block/actions.js";
import type {
  BlockDefinition,
  BlockDefinitionId
} from "#ir/block/definitions.js";
import type {
  BlockExit,
  BlockExitId
} from "#ir/block/exits.js";
import type {
  BlockActionSite,
  BlockDefinitionSite,
  BlockTimelineSite,
  Placement
} from "#ir/block/timeline.js";
import type { WalkedBlock } from "#ir/block/walk/types.js";

export type MainPath = Readonly<{ kind: "main" }>;

export type BranchPath = Readonly<{
  kind: "branch";
  at: Placement;
  arm: BranchArm;
}>;

export type ExitPath = Readonly<{
  kind: "exit";
  exit: BlockExitId;
  exitKind: BlockExit["kind"];
}>;

/**
 * Path identity is owned by a PathGeometry instance. Fields describe the path
 * for ordering/debugging, but a structurally identical clone is not the same
 * path and is not owned by the tree.
 */
export type Path =
  | MainPath
  | BranchPath
  | ExitPath;

export type BranchArm = "taken" | "notTaken";

export type PathEdge = Readonly<{
  parent: Path;
  child: Path;
}>;

export type PathGeometry = Readonly<{
  root: MainPath;
  edges: readonly PathEdge[];
  /**
   * Parent lookup by owned Path object identity. Do not use structural path
   * equality for path-tree traversal.
   */
  parentByPath: ReadonlyMap<Path, Path>;
}>;

export type TimelinePointIndex = Readonly<{
  bySite: ReadonlyMap<BlockTimelineSite, SitePoints>;
}>;

export type ProgramPoint = Readonly<{
  path: Path;
  at: Placement;
  phase: ProgramPointPhase;
}>;

export type ProgramPointPhase = "before" | "at" | "after";

export type SitePoints = Readonly<{
  before: ProgramPoint;
  at: ProgramPoint;
  after: ProgramPoint;
}>;

export type ExitPoint = Readonly<{
  exit: BlockExit;
  path: Path;
  point: ProgramPoint;
  sourceSite: BlockActionSite;
}>;

export type DefinitionPoint = Readonly<{
  definition: BlockDefinition;
  site: BlockDefinitionSite;
  point: ProgramPoint;
}>;

export type ActionSiteFor<TKind extends BlockAction["kind"]> =
  BlockActionSite &
  Readonly<{ action: Extract<BlockAction, { kind: TKind }> }>;

export type MemoryGuardPoint = Readonly<{
  site: ActionSiteFor<"memoryGuard">;
  point: ProgramPoint;
  faultExitPoint: ExitPoint;
}>;

export type MemoryWritePoint = Readonly<{
  site: ActionSiteFor<"memoryStore">;
  point: ProgramPoint;
}>;

export type DynamicRegisterStorePoint = Readonly<{
  site: ActionSiteFor<"dynamicRegisterStore">;
  point: ProgramPoint;
  preStatePoint: ProgramPoint;
}>;

export type ExitGeometry = Readonly<{
  points: readonly ExitPoint[];
  byExit: ReadonlyMap<BlockExitId, ExitPoint>;
}>;

export type DefinitionGeometry = Readonly<{
  points: readonly DefinitionPoint[];
  byDefinition: ReadonlyMap<BlockDefinitionId, DefinitionPoint>;
}>;

export type MemoryGeometry = Readonly<{
  guards: readonly MemoryGuardPoint[];
  writes: readonly MemoryWritePoint[];
}>;

export type RegisterGeometry = Readonly<{
  dynamicStores: readonly DynamicRegisterStorePoint[];
}>;

export type TimelineGeometry = Readonly<{
  paths: PathGeometry;
  points: TimelinePointIndex;
  exits: ExitGeometry;
  definitions: DefinitionGeometry;
  memory: MemoryGeometry;
  registers: RegisterGeometry;
}>;

export type TimelineGeometryInput = Pick<WalkedBlock, "timeline" | "exits">;
