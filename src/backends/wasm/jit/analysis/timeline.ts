import { createJitValueStateFromSnapshot } from "#backends/wasm/jit/state/value-state.js";
import type {
  ProducedDefinition,
  SlotWrite,
  Timeline,
  TimelineStorage,
  ValueSnapshot
} from "./timeline-types.js";
import { TimelineOpView } from "./timeline-view.js";

export function createTimeline(input: Readonly<{
  entry: ValueSnapshot;
  finalState: ValueSnapshot;
  opCount: number;
  writes: readonly SlotWrite[];
  produced: readonly ProducedDefinition[];
  storage: TimelineStorage;
}>): Timeline {
  const snapshots = new Map<number, ValueSnapshot>([
    [0, input.entry],
    [input.opCount, input.finalState]
  ]);

  return {
    finalState: input.finalState,
    writes: input.writes,
    produced: input.produced,
    viewAt: (opIndex) => new TimelineOpView(input.storage, input.opCount, opIndex),
    snapshotAt: (opIndex) => {
      validateSnapshotIndex(opIndex, input.opCount);
      const cached = snapshots.get(opIndex);

      if (cached !== undefined) {
        return cached;
      }

      const snapshot = replaySnapshot(input.entry, input.writes, opIndex);

      snapshots.set(opIndex, snapshot);
      return snapshot;
    }
  };
}

function validateSnapshotIndex(opIndex: number, opCount: number): void {
  if (!Number.isInteger(opIndex) || opIndex < 0 || opIndex > opCount) {
    throw new Error(`missing JIT timeline snapshot boundary for expression op ${opIndex}`);
  }
}

function replaySnapshot(
  entry: ValueSnapshot,
  writes: readonly SlotWrite[],
  opIndex: number
): ValueSnapshot {
  const state = createJitValueStateFromSnapshot(entry);

  for (const write of writes) {
    if (write.opIndex >= opIndex) {
      break;
    }

    state.slots.write(write.slot, write.value);
  }

  return state.snapshot();
}
