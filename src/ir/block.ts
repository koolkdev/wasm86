import type { Action, ContinueAction, ExitAction, WriteStateAction } from "./actions.js";
import type { ValueId, ValueTable } from "./values.js";

export type RegionId = number;

export type EntryRegion = Readonly<{
  id: RegionId;
  kind: "entry";
  actions: readonly Action[];
  // The flushed eip a completed region continues at; a continue without
  // one stays at the current eip.
  continuation?: ValueId;
}>;

// Edge bodies flush state and leave.
export type EdgeRegion = Readonly<{
  id: RegionId;
  kind: "edge";
  flushes: readonly WriteStateAction[];
  terminator: ExitAction | ContinueAction;
  continuation?: ValueId;
}>;

export type IrRegion = EntryRegion | EdgeRegion;

export type IrBlock = Readonly<{
  entry: RegionId;
  regions: readonly IrRegion[];
  values: ValueTable;
}>;
