import { assert } from "#common/assert.js";
import type { StateWriteAction } from "../actions.js";
import {
  channelCovers,
  channelsOverlap,
  type GprDynamicSlot,
  type GprChannel
} from "../slots.js";
import {
  fitsUnsigned,
  signExtended,
  type ValueId,
  type ValueTable,
  type WidthBounds
} from "../values.js";
import { PendingStateAccess } from "./state-access.js";
import type { PendingPathKind } from "./state.js";

export type PendingReadOptions = Readonly<{ signed?: boolean }>;

type PendingEntry = { value: ValueId; dirty: boolean };

// GPRs have byte aliases and dynamic register slots, so they need ordering
// rules that exact state channels do not.
export class PendingGprs {
  readonly #values: ValueTable;
  readonly #state: PendingStateAccess;
  readonly #pending = new Map<GprChannel, PendingEntry>();
  readonly #reads = new Map<GprChannel, ValueId>();
  readonly #signedReads = new Map<GprChannel, ValueId>();
  #boundary = new Map<GprChannel, ValueId>();
  #unrestorableStore = false;

  constructor(values: ValueTable, state: PendingStateAccess) {
    this.#values = values;
    this.#state = state;
  }

  read(channel: GprChannel, options: PendingReadOptions = {}): ValueId {
    const signed = options.signed === true && narrowBits(channel) !== undefined;
    const exact = this.#pending.get(channel);

    if (exact !== undefined) {
      return this.#narrowPendingValue(channel, exact.value, signed);
    }

    for (const [other, entry] of this.#pending) {
      if (channelsOverlap(other, channel)) {
        this.#flush(other, entry);
      }
    }

    const cache = signed ? this.#signedReads : this.#reads;
    const cached = cache.get(channel);

    if (cached !== undefined) {
      return cached;
    }

    const output = this.#state.read(channel, gprReadBounds(channel.byteLength, signed), signed);

    cache.set(channel, output);
    return output;
  }

  write(channel: GprChannel, value: ValueId): void {
    for (const [other, entry] of this.#pending) {
      if (other === channel || !channelsOverlap(other, channel)) {
        continue;
      }

      if (!channelCovers(channel, other)) {
        this.#flush(other, entry);
      }

      this.#pending.delete(other);
    }

    if (this.#isInputRestore(channel, value)) {
      this.#pending.delete(channel);
      return;
    }

    this.#pending.set(channel, { value, dirty: true });
  }

  readDynamic(slot: GprDynamicSlot, options: PendingReadOptions = {}): ValueId {
    const signed = options.signed === true && slot.byteLength !== 4;

    this.#flushDirty();

    return this.#state.read(slot, gprReadBounds(slot.byteLength, signed), signed);
  }

  writeDynamic(slot: GprDynamicSlot, value: ValueId): void {
    this.#flushDirty();
    this.#state.write(slot, value);
    this.#unrestorableStore = true;
    this.#pending.clear();
    this.#reads.clear();
    this.#signedReads.clear();
  }

  has(channel: GprChannel): boolean {
    return this.#pending.has(channel);
  }

  beginInstruction(): void {
    this.#boundary = new Map(
      [...this.#pending].map(([channel, entry]) => [channel, entry.value])
    );
    this.#unrestorableStore = false;
  }

  flushesForPath(path: PendingPathKind): readonly StateWriteAction[] {
    const entries = path === "fault"
      ? this.#snapshotEntries()
      : this.#currentEntries();

    return entries.map(([slot, value]) => ({ kind: "op", op: { kind: "state.write", slot, value } }));
  }

  #snapshotEntries(): ReadonlyArray<readonly [GprChannel, ValueId]> {
    assert(
      !this.#unrestorableStore,
      "a store this instruction overwrote bytes absent from the boundary snapshot; the pre-instruction state is unrestorable"
    );

    return [...this.#boundary];
  }

  #currentEntries(): ReadonlyArray<readonly [GprChannel, ValueId]> {
    return [...this.#pending].flatMap(([channel, entry]) => (
      entry.dirty ? [[channel, entry.value] as const] : []
    ));
  }

  #flush(channel: GprChannel, entry: PendingEntry): void {
    if (!entry.dirty) {
      return;
    }

    // A boundary-absent channel's pre-instruction bytes exist only in the
    // cpu-state memory; this store destroys them. A live cached read of the exact
    // channel is still that value, so it joins the boundary.
    if (!this.#boundary.has(channel)) {
      const cached = this.#reads.get(channel) ?? this.#signedReads.get(channel);

      if (cached !== undefined) {
        this.#boundary.set(channel, cached);
      } else {
        this.#unrestorableStore = true;
      }
    }

    this.#state.write(channel, entry.value);
    entry.dirty = false;
    this.#invalidateReadsOverlapping(channel);
  }

  #flushDirty(): void {
    for (const [channel, entry] of this.#pending) {
      this.#flush(channel, entry);
    }
  }

  #invalidateReadsOverlapping(channel: GprChannel): void {
    for (const cache of [this.#reads, this.#signedReads]) {
      for (const cached of cache.keys()) {
        if (channelsOverlap(cached, channel)) {
          cache.delete(cached);
        }
      }
    }
  }

  #isInputRestore(channel: GprChannel, value: ValueId): boolean {
    return this.#reads.get(channel) === value || this.#signedReads.get(channel) === value;
  }

  // A pending narrow value is only contractually valid in its low bits - the
  // flush store masks the rest. An exact hit normalizes through the smart
  // constructors, which is free whenever the value's width bounds already
  // cover the channel.
  #narrowPendingValue(channel: GprChannel, value: ValueId, signed: boolean): ValueId {
    const bits = narrowBits(channel);

    if (bits === undefined) {
      return value;
    }

    return signed ? this.#values.extend(bits, value, true) : this.#values.truncate(bits, value);
  }
}

function narrowBits(channel: GprChannel): 8 | 16 | undefined {
  if (channel.byteLength === 4) {
    return undefined;
  }

  return channel.byteLength === 1 ? 8 : 16;
}

function gprReadBounds(byteLength: 1 | 2 | 4, signed: boolean): WidthBounds | undefined {
  switch (byteLength) {
    case 1:
      return signed ? signExtended(8) : fitsUnsigned(8);
    case 2:
      return signed ? signExtended(16) : fitsUnsigned(16);
    case 4:
      return undefined;
  }
}
