import type { BlockExit } from "#ir/block/exits.js";
import type { BlockTimeline } from "#ir/block/timeline.js";
import type { BlockState } from "./state.js";

export type WalkedBlock = Readonly<{
  entry: BlockState;
  final: BlockState;
  timeline: BlockTimeline;
  exits: readonly BlockExit[];
}>;

export type BlockWalkResult = WalkedBlock;
