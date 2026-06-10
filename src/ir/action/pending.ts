import { assert } from "#common/assert.js";
import { channelCovers, channelsOverlap, type StateChannel } from "./slots.js";
import type { Action } from "./types.js";
import {
  fitsUnsigned,
  signExtended,
  type ValueId,
  type ValueTable,
  type WidthBounds
} from "./values.js";

// The pending map — the one materialization mechanism. A channel's latest
// write stays symbolic until architectural state becomes observable or an
// overlapping access forces it out. No bit algebra on register state, ever:
// state memory is the bit-combiner.
//
// The rule table:
// - Read: exact channel hit -> the pending value. Disjoint from all pendings
//   -> readState at the channel's width. Overlap mismatch -> flush the
//   overlapping pendings, then readState.
// - Write: a write that fully covers a pending channel drops it (its bytes
//   are entirely overwritten). A partial overlap flushes the overlapped
//   pending first. Then pending[channel] = value.
//
// Pendings stay pairwise disjoint by construction: the write rule clears
// every overlap before inserting.
//
// Fault edges flush *pre-instruction* state — a faulting instruction
// re-executes, so its own writes must not be visible. beginInstruction()
// copies the pending map; snapshot() returns the copy.

export type PendingReadOptions = Readonly<{ signed?: boolean }>;

export type PendingChannels = Readonly<{
  read(channel: StateChannel, options?: PendingReadOptions): ValueId;
  write(channel: StateChannel, value: ValueId): void;
  has(channel: StateChannel): boolean;
  // Marks an instruction boundary for snapshot().
  beginInstruction(): void;
  // The pending map as of the last instruction boundary; the live map is
  // untouched.
  snapshot(): ReadonlyArray<readonly [StateChannel, ValueId]>;
  // The live pending map, for edges that observe completed-instruction state.
  entries(): ReadonlyArray<readonly [StateChannel, ValueId]>;
  // Materializes every pending as a writeState, in insertion order.
  flushAll(): void;
}>;

export function createPendingChannels(
  values: ValueTable,
  emit: (action: Action) => void
): PendingChannels {
  const pending = new Map<StateChannel, ValueId>();
  // readState leaf per channel; a channel is read at most once between
  // flushes. Entries overlapping a flushed channel are dropped — a stale
  // leaf would silently serve a channel whose memory has changed.
  const reads = new Map<StateChannel, ValueId>();
  const signedReads = new Map<StateChannel, ValueId>();
  let boundary = new Map<StateChannel, ValueId>();
  let unrestorableFlush = false;

  function flush(channel: StateChannel, value: ValueId): void {
    // A boundary-absent channel's pre-instruction bytes exist only in state
    // memory; this store destroys them.
    if (!boundary.has(channel)) {
      unrestorableFlush = true;
    }

    emit({ kind: "writeState", slot: channel, value });
    pending.delete(channel);

    for (const cache of [reads, signedReads]) {
      for (const cached of cache.keys()) {
        if (channelsOverlap(cached, channel)) {
          cache.delete(cached);
        }
      }
    }
  }

  function read(channel: StateChannel, options: PendingReadOptions = {}): ValueId {
    // Sign-extension is meaningful only below the word: a "signed" read of a
    // full-width channel (or of a 0/1 flag byte) is the plain read.
    const signed = options.signed === true && narrowBits(channel) !== undefined;
    const exact = pending.get(channel);

    if (exact !== undefined) {
      return narrowPendingValue(channel, exact, signed);
    }

    for (const [other, value] of pending) {
      if (channelsOverlap(other, channel)) {
        flush(other, value);
      }
    }

    const cache = signed ? signedReads : reads;
    const cached = cache.get(channel);

    if (cached !== undefined) {
      return cached;
    }

    const output = values.addActionOutput(channelReadBounds(channel, signed));

    emit(
      signed
        ? { kind: "readState", output, slot: channel, signed: true }
        : { kind: "readState", output, slot: channel }
    );
    cache.set(channel, output);
    return output;
  }

  // A pending narrow value is only contractually valid in its low bits — the
  // flush store masks the rest. An exact hit normalizes through the smart
  // constructors, which is free whenever the value's width bounds already
  // cover the channel (the common case: semantics project narrow results).
  function narrowPendingValue(channel: StateChannel, value: ValueId, signed: boolean): ValueId {
    const bits = narrowBits(channel);

    if (bits === undefined) {
      return value;
    }

    return signed ? values.extendTo(bits, value) : values.projectTo(bits, value);
  }

  function write(channel: StateChannel, value: ValueId): void {
    for (const [other, otherValue] of pending) {
      if (other === channel || !channelsOverlap(other, channel)) {
        continue;
      }

      if (channelCovers(channel, other)) {
        pending.delete(other);
      } else {
        flush(other, otherValue);
      }
    }

    pending.set(channel, value);
  }

  function snapshot(): ReadonlyArray<readonly [StateChannel, ValueId]> {
    assert(
      !unrestorableFlush,
      "a channel first written this instruction was flushed; its pre-instruction bytes are unrestorable"
    );

    return [...boundary];
  }

  return {
    read,
    write,
    has: (channel) => pending.has(channel),
    beginInstruction(): void {
      boundary = new Map(pending);
      unrestorableFlush = false;
    },
    snapshot,
    entries: () => [...pending],
    flushAll(): void {
      for (const [channel, value] of pending) {
        flush(channel, value);
      }
    }
  };
}

function narrowBits(channel: StateChannel): 8 | 16 | undefined {
  if (channel.kind !== "gpr" || channel.byteLength === 4) {
    return undefined;
  }

  return channel.byteLength === 1 ? 8 : 16;
}

function channelReadBounds(channel: StateChannel, signed: boolean): WidthBounds | undefined {
  switch (channel.kind) {
    case "gpr": {
      const bits = narrowBits(channel);

      if (bits === undefined) {
        return undefined;
      }

      return signed ? signExtended(bits) : fitsUnsigned(bits);
    }
    case "flag":
      // Flag bytes hold 0 or 1 by the flag-write contract.
      return fitsUnsigned(1);
    case "eip":
      return undefined;
  }
}
