import type { BlockAction } from "#ir/block/actions.js";
import type { BlockExit } from "#ir/block/exits.js";
import type {
  BlockActionSite,
  BlockTimelineSite
} from "#ir/block/timeline.js";
import type { WalkedBlock } from "#ir/block/walk/types.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  BlockEdge,
  BlockEdgeId,
  ExitPoint,
  ProgramPoint,
  TimelineGeometry
} from "../geometry/index.js";

export type TimelineValueUseId = number & { readonly __timelineValueUseId: unique symbol };

export type TimelineActionInputRole = "address" | "value" | "index" | "condition";
export type TimelineExitPayloadRole = "address" | "target" | "vector";

export type TimelineValueUse =
  | Readonly<{
      id: TimelineValueUseId;
      kind: "action-input";
      site: BlockActionSite;
      role: TimelineActionInputRole;
      expr: ExprRef;
      point: ProgramPoint;
    }>
  | Readonly<{
      id: TimelineValueUseId;
      kind: "exit-payload";
      edge: BlockEdgeId;
      role: TimelineExitPayloadRole;
      expr: ExprRef;
      point: ProgramPoint;
    }>;

export type TimelineValueUseIndex = Readonly<{
  all: readonly TimelineValueUse[];
  bySite: ReadonlyMap<BlockTimelineSite, readonly TimelineValueUse[]>;
  byId: ReadonlyMap<TimelineValueUseId, TimelineValueUse>;
}>;

export type TimelineValueUseIndexInput = Readonly<{
  walked: Pick<WalkedBlock, "timeline">;
  geometry: TimelineGeometry;
}>;

class TimelineValueUseIds {
  #next = 0;

  next(): TimelineValueUseId {
    const id = this.#next;

    this.#next += 1;
    return id as TimelineValueUseId;
  }
}

export function buildTimelineValueUseIndex(input: TimelineValueUseIndexInput): TimelineValueUseIndex {
  const ids = new TimelineValueUseIds();
  const all: TimelineValueUse[] = [];
  const bySite = new Map<BlockTimelineSite, readonly TimelineValueUse[]>();
  const byId = new Map<TimelineValueUseId, TimelineValueUse>();

  for (const site of input.walked.timeline) {
    const uses = Object.freeze(siteTimelineValueUses(site, input.geometry, ids));

    bySite.set(site, uses);

    for (const use of uses) {
      all.push(use);
      byId.set(use.id, use);
    }
  }

  return Object.freeze({
    all: Object.freeze([...all]),
    bySite: Object.freeze(new Map(bySite)),
    byId: Object.freeze(new Map(byId))
  } satisfies TimelineValueUseIndex);
}

function siteTimelineValueUses(
  site: BlockTimelineSite,
  geometry: TimelineGeometry,
  ids: TimelineValueUseIds
): readonly TimelineValueUse[] {
  switch (site.kind) {
    case "definition":
      return [];
    case "action":
      return actionUses(site, geometry, ids);
  }
}

function actionUses(
  site: BlockActionSite,
  geometry: TimelineGeometry,
  ids: TimelineValueUseIds
): readonly TimelineValueUse[] {
  const point = sitePoint(site, geometry);

  switch (site.action.kind) {
    case "memoryGuard": {
      const faultPoint = exitPoint(site.action.faultExit, site, geometry).point;
      const faultEdge = exitEdge(site.action.faultExit, site, geometry);

      return [
        actionInput(ids.next(), site, site.action.address, point, "address"),
        exitPayload(ids.next(), faultEdge.id, site.action.address, faultPoint, "address")
      ];
    }
    case "memoryStore":
      return [
        actionInput(ids.next(), site, site.action.address, point, "address"),
        actionInput(ids.next(), site, site.action.value, point, "value")
      ];
    case "dynamicRegisterStore":
      return [
        actionInput(ids.next(), site, site.action.index, point, "index"),
        actionInput(ids.next(), site, site.action.value, point, "value")
      ];
    case "jump":
      return [
        exitPayload(
          ids.next(),
          exitEdge(site.action.exit, site, geometry).id,
          site.action.target,
          exitPoint(site.action.exit, site, geometry).point,
          "target"
        )
      ];
    case "branch":
      return branchUses(site, site.action, geometry, ids);
    case "hostTrap":
      return [
        exitPayload(
          ids.next(),
          exitEdge(site.action.exit, site, geometry).id,
          site.action.vector,
          exitPoint(site.action.exit, site, geometry).point,
          "vector"
        )
      ];
    case "fallthrough":
      return site.action.continuation.value === undefined
        ? []
        : [
          exitPayload(
            ids.next(),
            exitEdge(site.action.exit, site, geometry).id,
            site.action.continuation.value,
            exitPoint(site.action.exit, site, geometry).point,
            "target"
          )
        ];
  }
}

function branchUses(
  site: BlockActionSite,
  action: Extract<BlockAction, { kind: "branch" }>,
  geometry: TimelineGeometry,
  ids: TimelineValueUseIds
): readonly TimelineValueUse[] {
  const uses = [
    actionInput(ids.next(), site, action.condition, sitePoint(site, geometry), "condition"),
    exitPayload(
      ids.next(),
      exitEdge(action.taken, site, geometry).id,
      action.takenTarget,
      exitPoint(action.taken, site, geometry).point,
      "target"
    )
  ];

  return action.continuation.value === undefined
    ? uses
    : [
      ...uses,
      exitPayload(
        ids.next(),
        exitEdge(action.notTaken, site, geometry).id,
        action.continuation.value,
        exitPoint(action.notTaken, site, geometry).point,
        "target"
      )
    ];
}

function actionInput(
  id: TimelineValueUseId,
  site: BlockActionSite,
  expr: ExprRef,
  point: ProgramPoint,
  role: TimelineActionInputRole
): TimelineValueUse {
  return Object.freeze({
    id,
    kind: "action-input",
    site,
    expr,
    point,
    role
  } satisfies TimelineValueUse);
}

function exitPayload(
  id: TimelineValueUseId,
  edge: BlockEdgeId,
  expr: ExprRef,
  point: ProgramPoint,
  role: TimelineExitPayloadRole
): TimelineValueUse {
  return Object.freeze({
    id,
    kind: "exit-payload",
    edge,
    expr,
    point,
    role
  } satisfies TimelineValueUse);
}

function sitePoint(site: BlockTimelineSite, geometry: TimelineGeometry): ProgramPoint {
  const points = geometry.points.bySite.get(site);

  if (points === undefined) {
    throw new Error("timeline geometry is missing points for a walked timeline site");
  }

  return points.at;
}

function exitPoint(
  exit: BlockExit,
  site: BlockActionSite,
  geometry: TimelineGeometry
): ExitPoint {
  const point = geometry.exits.byExit.get(exit.id);

  if (point === undefined) {
    throw new Error(`timeline geometry is missing exit point ${exit.id}`);
  }

  if (point.sourceSite !== site) {
    throw new Error(`timeline geometry exit point ${exit.id} is attached to the wrong site`);
  }

  return point;
}

function exitEdge(
  exit: BlockExit,
  site: BlockActionSite,
  geometry: TimelineGeometry
): BlockEdge {
  const edge = geometry.edges.byExit.get(exit.id);

  if (edge === undefined) {
    throw new Error(`timeline geometry is missing edge for exit ${exit.id}`);
  }

  if (edge.sourceSite !== site) {
    throw new Error(`timeline geometry edge ${edge.id} is attached to the wrong site`);
  }

  return edge;
}
