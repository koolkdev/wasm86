import type { BlockAction } from "#ir/block/actions.js";
import type { BlockDefinition } from "#ir/block/definitions.js";
import type { BlockExit } from "#ir/block/exits.js";
import type { BlockState } from "#ir/block/walk/state.js";

export type Placement = Readonly<{
  opIndex: number;
  epoch: number;
}>;

export type ActionScheduleEntry = Readonly<{
  role: "action";
  at: Placement;
  action: BlockAction;
}>;

export type DefinitionScheduleEntry = Readonly<{
  role: "definition";
  at: Placement;
  definition: BlockDefinition;
}>;

export type BoundaryScheduleEntry =
  | Readonly<{
      role: "boundary";
      kind: "exitState";
      at: Placement;
      exit: BlockExit;
      state: BlockState;
    }>
  | Readonly<{
      role: "boundary";
      kind: "stateSync";
      at: Placement;
      state: BlockState;
    }>;

export type BlockScheduleEntry =
  | ActionScheduleEntry
  | DefinitionScheduleEntry
  | BoundaryScheduleEntry;

export type BlockSchedule = readonly BlockScheduleEntry[];
