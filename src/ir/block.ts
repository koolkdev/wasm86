import type { Action, DispatchAction, EdgeFlushAction, ExitAction } from "./actions.js";
import type { ValueTable } from "./values.js";

export type RegionId = number;

export type EntryRegion = Readonly<{
  id: RegionId;
  kind: "entry";
  actions: readonly Action[];
}>;

// Edge bodies flush state and leave.
export type EdgeRegion = Readonly<{
  id: RegionId;
  kind: "edge";
  flushes: readonly EdgeFlushAction[];
  terminator: ExitAction | DispatchAction;
}>;

export type IrRegion = EntryRegion | EdgeRegion;

export type IrBlock = Readonly<{
  entry: RegionId;
  regions: readonly IrRegion[];
  values: ValueTable;
}>;
