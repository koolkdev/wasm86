import type { BlockExit } from "#ir/block/exits.js";
import type { BlockTimelineSite } from "#ir/block/timeline.js";
import type { BlockState } from "./state.js";

export type BlockWalkResult = Readonly<{
  final: BlockState;
  timeline: readonly BlockTimelineSite[];
  exits: readonly BlockExit[];
}>;
