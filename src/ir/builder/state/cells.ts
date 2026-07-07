import { assert } from "#common/assert.js";
import {
  type FlagChannel,
  type EipChannel,
  type InstructionCountChannel,
  type LazyFlagsChannel,
  type SegmentChannel,
  channelsOverlap
} from "../../slots.js";
import {
  fitsUnsigned,
  type ValueId,
  type WidthBounds
} from "../../values.js";
import type { StateWriteAction } from "../../actions.js";
import { StateAccess } from "./access.js";
import { PendingBuffer, type StatePathKind } from "./pending-buffer.js";

export type { StatePathKind };

export type StateCell = FlagChannel | SegmentChannel | EipChannel | InstructionCountChannel | LazyFlagsChannel;

// Exact state cells are independent state slots tracked by exact key: the
// pending buffer holds the transactional writes, StateAccess the clean reads.
export class StateCells {
  readonly #state: StateAccess;
  readonly #buffer = new PendingBuffer<StateCell>();

  constructor(state: StateAccess) {
    this.#state = state;
  }

  read(channel: StateCell): ValueId {
    const exact = this.#buffer.get(channel);

    if (exact !== undefined) {
      return exact.value;
    }

    this.#assertNoOverlappingEntries(channel);

    return this.#state.readInput(channel, channelReadBounds(channel));
  }

  write(channel: StateCell, value: ValueId): void {
    this.#assertNoOverlappingEntries(channel);

    if (this.#state.cachedInput(channel) === value) {
      this.#buffer.delete(channel);
      return;
    }

    this.#buffer.set(channel, value);
  }

  invalidate(channel: StateCell): void {
    this.#buffer.delete(channel);
    this.#state.invalidateInput(channel);
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

  flushesForPath(path: StatePathKind): readonly StateWriteAction[] {
    return this.#buffer.flushes(path);
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
