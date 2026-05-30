import type { BlockAction } from "#ir/block/actions.js";
import type { BlockDefinition } from "#ir/block/definitions.js";
import type { BlockExit } from "#ir/block/exits.js";
import type { BlockState } from "#ir/block/walk/state.js";

export type Placement = Readonly<{
  opIndex: number;
  epoch: number;
}>;

export type BlockActionSite = Readonly<{
  kind: "action";
  at: Placement;
  action: BlockAction;
}>;

export type BlockDefinitionSite = Readonly<{
  kind: "definition";
  at: Placement;
  definition: BlockDefinition;
}>;

export type BlockBoundary =
  | Readonly<{
      kind: "exitState";
      exit: BlockExit;
      state: BlockState;
    }>
  | Readonly<{
      kind: "stateSync";
      state: BlockState;
    }>;

export type BlockBoundarySite = Readonly<{
  kind: "boundary";
  at: Placement;
  boundary: BlockBoundary;
}>;

export type BlockTimelineSite =
  | BlockActionSite
  | BlockDefinitionSite
  | BlockBoundarySite;

export type BlockTimeline = readonly BlockTimelineSite[];

export function actionSites(timeline: readonly BlockTimelineSite[]): readonly BlockActionSite[] {
  return Object.freeze(timeline.filter((site): site is BlockActionSite =>
    site.kind === "action"
  ));
}

export function definitionSites(timeline: readonly BlockTimelineSite[]): readonly BlockDefinitionSite[] {
  return Object.freeze(timeline.filter((site): site is BlockDefinitionSite =>
    site.kind === "definition"
  ));
}

export function boundarySites(timeline: readonly BlockTimelineSite[]): readonly BlockBoundarySite[] {
  return Object.freeze(timeline.filter((site): site is BlockBoundarySite =>
    site.kind === "boundary"
  ));
}

function comparePlacement(left: Placement, right: Placement): number {
  const opOrder = left.opIndex - right.opIndex;

  return opOrder === 0
    ? left.epoch - right.epoch
    : opOrder;
}

export function placementBefore(left: Placement, right: Placement): boolean {
  return comparePlacement(left, right) < 0;
}

export function placementAfter(left: Placement, right: Placement): boolean {
  return comparePlacement(left, right) > 0;
}
