import type { BlockExit } from "#ir/block/exits.js";
import type { BlockSchedule } from "../schedule.js";
import type { BlockState } from "./state.js";

export type {
  ActionScheduleEntry,
  BlockSchedule,
  BlockScheduleEntry,
  BoundaryScheduleEntry,
  DefinitionScheduleEntry,
  Placement
} from "../schedule.js";

export type BlockWalkResult = Readonly<{
  final: BlockState;
  schedule: BlockSchedule;
  exits: readonly BlockExit[];
}>;
