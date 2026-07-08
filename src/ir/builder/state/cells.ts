import { assert } from "#common/assert.js";
import {
  type FlagChannel,
  type EipChannel,
  type InstructionCountChannel,
  type LazyFlagsChannel,
  type StateSlot,
  type SegmentChannel,
  channelsOverlap
} from "../../slots.js";
import {
  fitsUnsigned,
  type ValueId,
  type WidthBounds
} from "../../values.js";
import type { StateWriteAction } from "../../actions.js";
import type { BodyBuilder } from "../../body-builder.js";
import { PendingBuffer, type PendingBufferSnapshot, type StatePathKind } from "./pending-buffer.js";

export type { StatePathKind };

export type StateCell = FlagChannel | SegmentChannel | EipChannel | InstructionCountChannel | LazyFlagsChannel;

type StateCellsSnapshot = Readonly<{
  buffer: PendingBufferSnapshot<StateCell>;
  inputReads: ReadonlyMap<StateCell, ValueId>;
}>;

// Exact state cells are independent state slots tracked by exact key: the
// pending buffer holds the transactional writes, and this store owns clean
// reads for exact-keyed cells.
export class StateCells {
  readonly #currentBody: () => BodyBuilder;
  readonly #buffer = new PendingBuffer<StateCell>();
  readonly #inputReads = new Map<StateCell, ValueId>();

  constructor(currentBody: () => BodyBuilder) {
    this.#currentBody = currentBody;
  }

  read(channel: StateCell): ValueId {
    const exact = this.#buffer.get(channel);

    if (exact !== undefined) {
      return exact.value;
    }

    this.#assertNoOverlappingEntries(channel);

    const cached = this.#inputReads.get(channel);

    if (cached !== undefined) {
      return cached;
    }

    const output = this.#readState(channel);

    this.#inputReads.set(channel, output);
    return output;
  }

  write(channel: StateCell, value: ValueId): void {
    this.#assertNoOverlappingEntries(channel);

    if (this.#inputReads.get(channel) === value) {
      this.#buffer.delete(channel);
      return;
    }

    this.#buffer.set(channel, value);
  }

  invalidate(channel: StateCell): void {
    this.#buffer.delete(channel);
    this.#inputReads.delete(channel);
  }

  has(channel: StateCell): boolean {
    return this.#buffer.has(channel);
  }

  // Whether memory does not hold the cell's current value.
  isDirty(channel: StateCell): boolean {
    return this.#buffer.get(channel)?.dirty === true;
  }

  beginInstruction(): void {
    this.#buffer.snapshotBoundary();
  }

  snapshot(): StateCellsSnapshot {
    return {
      buffer: this.#buffer.snapshot(),
      inputReads: new Map(this.#inputReads)
    };
  }

  restore(snapshot: StateCellsSnapshot): void {
    this.#buffer.restore(snapshot.buffer);
    this.#inputReads.clear();

    for (const [channel, value] of snapshot.inputReads) {
      this.#inputReads.set(channel, value);
    }
  }

  flushesForPath(path: StatePathKind): readonly StateWriteAction[] {
    return this.#buffer.flushes(path);
  }

  #readState(slot: StateSlot): ValueId {
    return this.#currentBody().opValue({ kind: "state.read", slot });
  }

  #assertNoOverlappingEntries(channel: StateCell): void {
    for (const [other] of this.#buffer.entries()) {
      assert(
        other === channel || !channelsOverlap(other, channel),
        `overlapping state cells are unsupported: ${JSON.stringify(other)} and ${JSON.stringify(channel)}`
      );
    }
  }
}

export function channelReadBounds(channel: StateCell): WidthBounds | undefined {
  switch (channel.kind) {
    case "flag":
      return fitsUnsigned(1);
    case "lazyFlags":
      return channel.field === "lazyFlagsKind" ? fitsUnsigned(8) : undefined;
    case "segment":
      return channel.field === "selector" ? fitsUnsigned(16) : undefined;
    case "eip":
    case "instructionCount":
      return undefined;
  }
}
