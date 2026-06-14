import { assert } from "#common/assert.js";
import { channelCovers, channelsOverlap, type StateChannel } from "./slots.js";
import type { Action, GprDynamicSlot } from "./actions.js";
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
// A pending is dirty until a flush stores it; a flushed pending stays in the
// map clean — its value matches state memory, so it keeps serving reads and
// never needs storing again.
//
// The rule table:
// - Read: exact channel hit -> the pending value. Disjoint from all pendings
//   -> readState at the channel's width. Overlap mismatch -> flush the
//   overlapping dirty pendings, then readState.
// - Write: an overlapped pending is dropped — flushed first when it is dirty
//   and only partially covered (its uncovered bytes must reach memory).
//   Then pending[channel] = value, dirty.
// - Dynamic access targets a runtime-selected GPR, so it orders like
//   memory: a read flushes the dirty GPR pendings first; a write also stores
//   immediately (it cannot pend — the channel is unknown) and invalidates
//   every GPR pending, clean ones included. Flags and eip are untouched.
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
  readDynamicGpr(slot: GprDynamicSlot, options?: PendingReadOptions): ValueId;
  writeDynamicGpr(slot: GprDynamicSlot, value: ValueId): void;
  has(channel: StateChannel): boolean;
  // Marks an instruction boundary for snapshot().
  beginInstruction(): void;
  // The pending map as of the last instruction boundary; the live map is
  // untouched.
  snapshot(): ReadonlyArray<readonly [StateChannel, ValueId]>;
  // The live dirty pendings, for edges that observe completed-instruction
  // state; clean values are already in state memory.
  entries(): ReadonlyArray<readonly [StateChannel, ValueId]>;
  // Materializes every dirty pending as a writeState, in insertion order.
  flushAll(): void;
}>;

type PendingEntry = { value: ValueId; dirty: boolean };

export function createPendingChannels(
  values: ValueTable,
  emit: (action: Action) => void
): PendingChannels {
  const pending = new Map<StateChannel, PendingEntry>();
  // readState leaf per channel; a channel is read at most once between
  // stores. Entries overlapping a stored channel are dropped — a stale
  // leaf would silently serve a channel whose memory has changed.
  const reads = new Map<StateChannel, ValueId>();
  const signedReads = new Map<StateChannel, ValueId>();
  let boundary = new Map<StateChannel, ValueId>();
  let unrestorableStore = false;

  function flush(channel: StateChannel, entry: PendingEntry): void {
    if (!entry.dirty) {
      return;
    }

    // A boundary-absent channel's pre-instruction bytes exist only in state
    // memory; this store destroys them. A live cached read of the exact
    // channel is still that value (any store would have invalidated it), so
    // it joins the boundary; a signed read serves too — its low
    // channel-width bits are the memory bytes.
    if (!boundary.has(channel)) {
      const cached = reads.get(channel) ?? signedReads.get(channel);

      if (cached !== undefined) {
        boundary.set(channel, cached);
      } else {
        unrestorableStore = true;
      }
    }

    emit({ kind: "writeState", slot: channel, value: entry.value });
    entry.dirty = false;
    invalidateReadsOverlapping(channel);
  }

  function invalidateReadsOverlapping(channel: StateChannel): void {
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
      return narrowPendingValue(channel, exact.value, signed);
    }

    for (const [other, entry] of pending) {
      if (channelsOverlap(other, channel)) {
        flush(other, entry);
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
    for (const [other, entry] of pending) {
      if (other === channel || !channelsOverlap(other, channel)) {
        continue;
      }

      if (!channelCovers(channel, other)) {
        flush(other, entry);
      }

      pending.delete(other);
    }

    pending.set(channel, { value, dirty: true });
  }

  function flushDirtyGprs(): void {
    for (const [channel, entry] of pending) {
      if (channel.kind === "gpr") {
        flush(channel, entry);
      }
    }
  }

  function readDynamicGpr(slot: GprDynamicSlot, options: PendingReadOptions = {}): ValueId {
    const signed = options.signed === true && slot.byteLength !== 4;

    flushDirtyGprs();

    const output = values.addActionOutput(gprReadBounds(slot.byteLength, signed));

    emit(
      signed
        ? { kind: "readState", output, slot, signed: true }
        : { kind: "readState", output, slot }
    );
    return output;
  }

  function writeDynamicGpr(slot: GprDynamicSlot, value: ValueId): void {
    flushDirtyGprs();
    emit({ kind: "writeState", slot, value });
    // No boundary snapshot can restore a runtime-selected register.
    unrestorableStore = true;

    for (const channel of pending.keys()) {
      if (channel.kind === "gpr") {
        pending.delete(channel);
      }
    }

    for (const cache of [reads, signedReads]) {
      for (const cached of cache.keys()) {
        if (cached.kind === "gpr") {
          cache.delete(cached);
        }
      }
    }
  }

  function snapshot(): ReadonlyArray<readonly [StateChannel, ValueId]> {
    assert(
      !unrestorableStore,
      "a store this instruction overwrote bytes absent from the boundary snapshot; the pre-instruction state is unrestorable"
    );

    return [...boundary];
  }

  return {
    read,
    write,
    readDynamicGpr,
    writeDynamicGpr,
    has: (channel) => pending.has(channel),
    beginInstruction(): void {
      boundary = new Map([...pending].map(([channel, entry]) => [channel, entry.value]));
      unrestorableStore = false;
    },
    snapshot,
    entries: () =>
      [...pending].flatMap(([channel, entry]) => (entry.dirty ? [[channel, entry.value] as const] : [])),
    flushAll(): void {
      for (const [channel, entry] of pending) {
        flush(channel, entry);
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
    case "gpr":
      return gprReadBounds(channel.byteLength, signed);
    case "flag":
      // Flag bytes hold 0 or 1 by the flag-write contract.
      return fitsUnsigned(1);
    case "eip":
    case "instructionCount":
      return undefined;
  }
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
