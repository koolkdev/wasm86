import type { ExprDeps } from "#ir/block/expr-deps.js";
import type {
  BlockBoundarySite,
  Placement
} from "#ir/block/timeline.js";
import type {
  ExprGraph,
  ExprNodeId
} from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { ValueRoot } from "./value-roots.js";
import type { ProducedValue } from "./produced-values.js";

export type BlockValuePlanInput = Readonly<{
  graph: ExprGraph;
  valueRoots: readonly ValueRoot[];
  producedValues: readonly ProducedValue[];
}>;

export type BlockValuePlan = Readonly<{
  values: readonly PlannedValue[];
  produced: readonly PlannedProducedValue[];
  boundaries: readonly PlannedBoundary[];
}>;

export type PlannedValueId = number & {
  readonly __plannedValueId: unique symbol;
};

export type PlannedLifetime = Readonly<{
  start: Placement;
  end: Placement;
}>;

export type PlannedValue = Readonly<{
  id: PlannedValueId;
  key: ExprNodeId;
  expr: ExprRef;
  roots: readonly ValueRoot[];
  deps: ExprDeps;
  lifetime: PlannedLifetime;
}>;

export type PlannedProducedValue = Readonly<{
  produced: ProducedValue;
  inputs: readonly ValueRoot[];
  consumers: readonly ValueRoot[];
  lifetime: PlannedLifetime;
}>;

export type PlannedBoundary = Readonly<{
  site: BlockBoundarySite;
  boundary: "stateSync" | "exitState";
  at: Placement;
  roots: readonly ValueRoot[];
}>;
