import type {
  MemoryLoadValue,
  SlotWrite,
  Timeline,
  TimelineStorage,
  ValueSnapshot
} from "./timeline-types.js";
import { TimelineOpView } from "./timeline-view.js";

export function createTimeline(input: Readonly<{
  finalState: ValueSnapshot;
  opCount: number;
  writes: readonly SlotWrite[];
  memoryLoadValues: readonly MemoryLoadValue[];
  snapshots: ReadonlyMap<number, ValueSnapshot>;
  storage: TimelineStorage;
}>): Timeline {
  return {
    finalState: input.finalState,
    writes: input.writes,
    memoryLoadValues: input.memoryLoadValues,
    viewAt: (opIndex) => new TimelineOpView(input.storage, input.opCount, opIndex),
    snapshotAt: (opIndex) => {
      const snapshot = input.snapshots.get(opIndex);

      if (snapshot === undefined) {
        throw new Error(`missing requested JIT timeline snapshot point for expression op ${opIndex}`);
      }

      return snapshot;
    }
  };
}
