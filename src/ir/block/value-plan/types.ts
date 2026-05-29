import type { ExprDeps } from "#ir/block/expr-deps.js";
import type {
  BlockScheduleEntry,
  BlockScheduleEntryIndex,
  Placement
} from "#ir/block/schedule.js";
import type { SourceCell } from "#ir/block/source-cells.js";
import type { ExprNodeId } from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  BoundaryCellValueSite,
  ValueSite
} from "./value-sites.js";
import type { ProducedValue } from "./produced-values.js";
import type { SourceEffect } from "./source-effects.js";

export type BlockValuePlanInput = Readonly<{
  sites: readonly ValueSite[];
  producedValues: readonly ProducedValue[];
  sourceEffects: readonly SourceEffect[];
}>;

export type BlockValuePlan = Readonly<{
  values: readonly PlannedValue[];
  produced: readonly PlannedProducedValue[];
  captures: readonly PlannedCapture[];
  boundaries: readonly PlannedBoundary[];
}>;

export type PlannedValueId = number & {
  readonly __plannedValueId: unique symbol;
};

export type PlannedLifetime = Readonly<{
  firstEntry: BlockScheduleEntryIndex;
  lastEntry: BlockScheduleEntryIndex;
}>;

export type PlannedValue = Readonly<{
  id: PlannedValueId;
  key: ExprNodeId;
  expr: ExprRef;
  sites: readonly ValueSite[];
  deps: ExprDeps;
  lifetime: PlannedLifetime;
}>;

export type PlannedProducedValue = Readonly<{
  produced: ProducedValue;
  consumers: readonly ValueSite[];
  lifetime: PlannedLifetime;
}>;

export type PlannedCapture = Readonly<{
  value: PlannedValueId;
  source: SourceCell;
  before: SourceEffect;
  entryIndex: BlockScheduleEntryIndex;
  at: Placement;
}>;

export type PlannedBoundary = Readonly<{
  entry: Extract<BlockScheduleEntry, { role: "boundary" }>;
  boundary: "stateSync" | "exitState";
  entryIndex: BlockScheduleEntryIndex;
  at: Placement;
  sites: readonly BoundaryCellValueSite[];
}>;
