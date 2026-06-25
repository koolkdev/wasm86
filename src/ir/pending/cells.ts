import { assert } from "#common/assert.js";
import type { X86Flag, X86StatusFlag } from "#x86/flags.js";
import {
  type FlagChannel,
  type EipChannel,
  type InstructionCountChannel,
  type LazyFlagsChannel,
  channelsOverlap
} from "../slots.js";
import {
  fitsUnsigned,
  type ValueId,
  type WidthBounds
} from "../values.js";
import type { WriteStateAction } from "../actions.js";
import type { PendingEdgeKind } from "./state.js";
import { PendingStateAccess } from "./state-access.js";

type X86NonStatusFlag = Exclude<X86Flag, X86StatusFlag>;
export type PendingCell = FlagChannel<X86NonStatusFlag> | EipChannel | InstructionCountChannel | LazyFlagsChannel;

type PendingEntry = { value: ValueId; dirty: boolean };

// Pending cells are independent state slots that can be tracked by exact key.
export class PendingCells<TCell extends PendingCell = PendingCell> {
  readonly #state: PendingStateAccess;
  readonly #pending = new Map<TCell, PendingEntry>();
  #boundary = new Map<TCell, ValueId>();

  constructor(state: PendingStateAccess) {
    this.#state = state;
  }

  read(channel: TCell): ValueId {
    const exact = this.#pending.get(channel);

    if (exact !== undefined) {
      return exact.value;
    }

    this.#assertNoOverlappingPending(channel);

    return this.#state.readInput(channel, channelReadBounds(channel));
  }

  write(channel: TCell, value: ValueId): void {
    this.#assertNoOverlappingPending(channel);
    this.#pending.set(channel, { value, dirty: true });
  }

  has(channel: TCell): boolean {
    return this.#pending.has(channel);
  }

  beginInstruction(): void {
    this.#boundary = new Map(
      [...this.#pending].map(([channel, entry]) => [channel, entry.value])
    );
  }

  flushesForEdge(edge: PendingEdgeKind): readonly WriteStateAction[] {
    const entries = edge === "fault"
      ? this.#snapshotEntries()
      : this.#currentEntries();

    return entries.map(([slot, value]) => ({ kind: "writeState", slot, value }));
  }

  #snapshotEntries(): ReadonlyArray<readonly [TCell, ValueId]> {
    return [...this.#boundary];
  }

  #currentEntries(): ReadonlyArray<readonly [TCell, ValueId]> {
    return [...this.#pending].flatMap(([channel, entry]) => (
      entry.dirty ? [[channel, entry.value] as const] : []
    ));
  }

  #assertNoOverlappingPending(channel: TCell): void {
    for (const other of this.#pending.keys()) {
      assert(
        other === channel || !channelsOverlap(other, channel),
        `overlapping pending cells are unsupported: ${JSON.stringify(other)} and ${JSON.stringify(channel)}`
      );
    }
  }
}

function channelReadBounds(channel: PendingCell): WidthBounds | undefined {
  switch (channel.kind) {
    case "flag":
      return fitsUnsigned(1);
    case "lazyFlags":
      return channel.field === "lazyFlagsKind" || channel.field === "lazyFlagsWidth"
        ? fitsUnsigned(8)
        : channel.field === "lazyFlagsHeader"
          ? fitsUnsigned(16)
          : undefined;
    case "eip":
    case "instructionCount":
      return undefined;
  }
}
