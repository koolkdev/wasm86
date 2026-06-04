import type { BlockAction } from "#ir/block/actions.js";
import type { BlockExit } from "#ir/block/exits.js";
import type {
  BlockActionSite,
  BlockDefinitionSite,
  BlockTimelineSite
} from "#ir/block/timeline.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  ExitPoint,
  ProgramPoint,
  TimelineGeometry
} from "../geometry/index.js";

export type TimelineValueUseOriginKind =
  | "action-input"
  | "definition-input"
  | "exit-payload";

export type TimelineValueUseRole =
  | "address"
  | "value"
  | "index"
  | "condition"
  | "target"
  | "vector";

export type TimelineValueUse = Readonly<{
  expr: ExprRef;
  point: ProgramPoint;
  originKind: TimelineValueUseOriginKind;
  role: TimelineValueUseRole;
}>;

export function timelineValueUses(
  site: BlockTimelineSite,
  geometry: TimelineGeometry
): readonly TimelineValueUse[] {
  switch (site.kind) {
    case "definition":
      return definitionUses(site, geometry);
    case "action":
      return actionUses(site, geometry);
  }
}

function definitionUses(
  site: BlockDefinitionSite,
  geometry: TimelineGeometry
): readonly TimelineValueUse[] {
  const point = definitionPoint(site, geometry).point;

  switch (site.definition.kind) {
    case "memoryLoad":
      return [projection(site.definition.address, point, "definition-input", "address")];
    case "dynamicRegisterLoad":
      return [projection(site.definition.index, point, "definition-input", "index")];
  }
}

function actionUses(
  site: BlockActionSite,
  geometry: TimelineGeometry
): readonly TimelineValueUse[] {
  const point = sitePoint(site, geometry);

  switch (site.action.kind) {
    case "memoryGuard": {
      const faultPoint = exitPoint(site.action.faultExit, site, geometry).point;

      return [
        projection(site.action.address, point, "action-input", "address"),
        projection(site.action.address, faultPoint, "exit-payload", "address")
      ];
    }
    case "memoryStore":
      return [
        projection(site.action.address, point, "action-input", "address"),
        projection(site.action.value, point, "action-input", "value")
      ];
    case "dynamicRegisterStore":
      return [
        projection(site.action.index, point, "action-input", "index"),
        projection(site.action.value, point, "action-input", "value")
      ];
    case "jump":
      return [
        projection(site.action.target, exitPoint(site.action.exit, site, geometry).point, "exit-payload", "target")
      ];
    case "branch":
      return branchUses(site, site.action, geometry);
    case "hostTrap":
      return [
        projection(site.action.vector, exitPoint(site.action.exit, site, geometry).point, "exit-payload", "vector")
      ];
    case "fallthrough":
      return site.action.continuation.value === undefined
        ? []
        : [
          projection(
            site.action.continuation.value,
            exitPoint(site.action.exit, site, geometry).point,
            "exit-payload",
            "target"
          )
        ];
  }
}

function branchUses(
  site: BlockActionSite,
  action: Extract<BlockAction, { kind: "branch" }>,
  geometry: TimelineGeometry
): readonly TimelineValueUse[] {
  const uses = [
    projection(action.condition, sitePoint(site, geometry), "action-input", "condition"),
    projection(action.takenTarget, exitPoint(action.taken, site, geometry).point, "exit-payload", "target")
  ];

  return action.continuation.value === undefined
    ? uses
    : [
      ...uses,
      projection(
        action.continuation.value,
        exitPoint(action.notTaken, site, geometry).point,
        "exit-payload",
        "target"
      )
    ];
}

function projection(
  expr: ExprRef,
  point: ProgramPoint,
  originKind: TimelineValueUseOriginKind,
  role: TimelineValueUseRole
): TimelineValueUse {
  return Object.freeze({
    expr,
    point,
    originKind,
    role
  });
}

function sitePoint(site: BlockTimelineSite, geometry: TimelineGeometry): ProgramPoint {
  const points = geometry.points.bySite.get(site);

  if (points === undefined) {
    throw new Error("timeline geometry is missing points for a walked timeline site");
  }

  return points.at;
}

function definitionPoint(
  site: BlockDefinitionSite,
  geometry: TimelineGeometry
): TimelineGeometry["definitions"]["points"][number] {
  const point = geometry.definitions.byDefinition.get(site.definition.id);

  if (point === undefined) {
    throw new Error(`timeline geometry is missing definition point ${site.definition.id}`);
  }

  if (point.site !== site) {
    throw new Error(`timeline geometry definition point ${site.definition.id} is attached to the wrong site`);
  }

  return point;
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
