import { assert } from "#common/assert.js";
import { stateRead, stateWrite } from "#compiler/ir/operations/state.js";
import type { OperandWidth, RegName } from "#core/types.js";
import type { StateWriteAction } from "../../actions.js";
import {
  channelCovers, channelsOverlap, gprChannel, type GprDynamicSlot, type GprChannel
} from "../../slots.js";
import {
  type ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { RegionBuilder } from "../../region-builder.js";
import { PendingBuffer, type PendingBufferSnapshot, type StatePathKind } from "./pending-buffer.js";
import type { StateWriteObserver } from "./write-log.js";

export type GprReadOptions = Readonly<{ signed?: boolean }>;

type GprStateSnapshot = Readonly<{
  buffer: PendingBufferSnapshot<GprChannel>;
  reads: ReadonlyMap<GprChannel, ValueId>;
  signedReads: ReadonlyMap<GprChannel, ValueId>;
  unrestorableStore: boolean;
}>;

// GPRs have byte aliases and dynamic register slots, so they need overlap
// rules the exact state cells do not. The pending buffer holds the
// transactional writes; the overlap policy, clean-read caches, and
// unrestorable-store tracking are GPR-specific and live here.
export class GprState {
  readonly #values: ValueTable;
  readonly #currentBody: () => RegionBuilder;
  readonly #buffer = new PendingBuffer<GprChannel>();
  readonly #reads = new Map<GprChannel, ValueId>();
  readonly #signedReads = new Map<GprChannel, ValueId>();
  readonly #writeObserver: StateWriteObserver | undefined;
  #unrestorableStore = false;

  constructor(values: ValueTable, currentBody: () => RegionBuilder, writeObserver?: StateWriteObserver) {
    this.#values = values;
    this.#currentBody = currentBody;
    this.#writeObserver = writeObserver;
  }

  read(reg: RegName | GprChannel, accessWidthOrOptions?: OperandWidth | GprReadOptions, options: GprReadOptions = {}): ValueId {
    const channel = this.#channel(reg);
    const readOptions = typeof accessWidthOrOptions === "number" ? options : accessWidthOrOptions ?? {};

    if (typeof accessWidthOrOptions === "number") {
      this.#assertAccessWidth("get from", channel, accessWidthOrOptions);
    }

    return this.#readChannel(channel, readOptions);
  }

  write(reg: RegName | GprChannel, value: ValueId, accessWidth?: OperandWidth): void {
    const channel = this.#channel(reg);

    this.#assertAccessWidth("set to", channel, accessWidth);
    this.#writeChannel(channel, value);
  }

  readDynamic(slot: GprDynamicSlot, options: GprReadOptions = {}): ValueId {
    const signed = options.signed === true && slot.byteLength !== 4;

    this.#flushDirty();

    return this.#readState(slot, signed);
  }

  writeDynamic(slot: GprDynamicSlot, value: ValueId): void {
    this.#flushDirty();
    this.#writeState(slot, value);
    this.#unrestorableStore = true;
    this.#buffer.clear();
    this.#reads.clear();
    this.#signedReads.clear();
  }

  readChannel(channel: GprChannel, options: GprReadOptions = {}): ValueId {
    return this.#readChannel(channel, options);
  }

  writeChannel(channel: GprChannel, value: ValueId): void {
    this.#writeChannel(channel, value);
  }

  #readChannel(channel: GprChannel, options: GprReadOptions = {}): ValueId {
    const signed = options.signed === true && narrowBits(channel) !== undefined;
    const exact = this.#buffer.get(channel);

    if (exact !== undefined) {
      return this.#narrowTrackedValue(channel, exact.value, signed);
    }

    for (const [other] of this.#buffer.entries()) {
      if (channelsOverlap(other, channel)) {
        this.#flush(other);
      }
    }

    const cache = signed ? this.#signedReads : this.#reads;
    const cached = cache.get(channel);

    if (cached !== undefined) {
      return cached;
    }

    const output = this.#readState(channel, signed);

    cache.set(channel, output);
    return output;
  }

  #writeChannel(channel: GprChannel, value: ValueId): void {
    this.#writeObserver?.recordStateWrite(channel);

    for (const [other] of this.#buffer.entries()) {
      if (other === channel || !channelsOverlap(other, channel)) {
        continue;
      }

      if (!channelCovers(channel, other)) {
        this.#flush(other);
      }

      this.#buffer.delete(other);
    }

    if (this.#isInputRestore(channel, value)) {
      this.#buffer.delete(channel);
      return;
    }

    this.#buffer.set(channel, value);
  }

  has(channel: GprChannel): boolean {
    return this.#buffer.has(channel);
  }

  // Whether memory does not hold the channel's current bytes: any
  // overlapping dirty entry counts.
  isChannelDirty(channel: GprChannel): boolean {
    for (const [other, entry] of this.#buffer.entries()) {
      if (entry.dirty && channelsOverlap(other, channel)) {
        return true;
      }
    }

    return false;
  }

  // Drops the channel's tracked value and cached reads; the next read goes
  // back to state memory.
  invalidate(channel: GprChannel): void {
    for (const [other] of this.#buffer.entries()) {
      if (channelsOverlap(other, channel)) {
        this.#buffer.delete(other);
      }
    }

    this.#invalidateReadsOverlapping(channel);
  }

  beginInstruction(): void {
    this.#buffer.snapshotBoundary();
    this.#unrestorableStore = false;
  }

  snapshot(): GprStateSnapshot {
    return {
      buffer: this.#buffer.snapshot(),
      reads: new Map(this.#reads),
      signedReads: new Map(this.#signedReads),
      unrestorableStore: this.#unrestorableStore
    };
  }

  restore(snapshot: GprStateSnapshot): void {
    this.#buffer.restore(snapshot.buffer);
    this.#reads.clear();
    this.#signedReads.clear();

    for (const [channel, value] of snapshot.reads) {
      this.#reads.set(channel, value);
    }

    for (const [channel, value] of snapshot.signedReads) {
      this.#signedReads.set(channel, value);
    }

    this.#unrestorableStore = snapshot.unrestorableStore;
  }

  flushesForPath(path: StatePathKind): readonly StateWriteAction[] {
    if (path === "fault") {
      assert(
        !this.#unrestorableStore,
        "a store this instruction overwrote bytes absent from the boundary snapshot; the pre-instruction state is unrestorable"
      );
    }

    return this.#buffer.flushes(path);
  }

  #flush(channel: GprChannel): void {
    const entry = this.#buffer.get(channel);

    if (entry === undefined || !entry.dirty) {
      return;
    }

    // A boundary-absent channel's pre-instruction bytes exist only in the
    // cpu-state memory; this store destroys them. A live cached read of the exact
    // channel is still that value, so it joins the boundary.
    if (!this.#buffer.boundaryHas(channel)) {
      const cached = this.#reads.get(channel) ?? this.#signedReads.get(channel);

      if (cached !== undefined) {
        this.#buffer.setBoundary(channel, cached);
      } else {
        this.#unrestorableStore = true;
      }
    }

    this.#writeState(channel, entry.value);
    this.#buffer.markClean(channel);
    this.#invalidateReadsOverlapping(channel);
  }

  #readState(slot: GprChannel | GprDynamicSlot, signed: boolean): ValueId {
    return this.#currentBody().operation(
      stateRead.create(
        signed
          ? { slot, signed: true }
          : { slot }
      )
    );
  }

  #writeState(slot: GprChannel | GprDynamicSlot, value: ValueId): void {
    this.#currentBody().operation(stateWrite.create({ slot, value }));
  }

  #flushDirty(): void {
    for (const [channel] of this.#buffer.entries()) {
      this.#flush(channel);
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

  #channel(reg: RegName | GprChannel): GprChannel {
    return typeof reg === "string" ? gprChannel(reg) : reg;
  }

  #assertAccessWidth(action: "get from" | "set to", channel: GprChannel, accessWidth: OperandWidth | undefined): void {
    if (accessWidth === undefined) {
      return;
    }

    assert(
      channel.byteLength * 8 === accessWidth,
      `${accessWidth}-bit ${action} a ${channel.byteLength * 8}-bit register channel`
    );
  }

  // A tracked narrow value is only contractually valid in its low bits - the
  // flush store masks the rest. An exact hit normalizes through the smart
  // constructors, which is free whenever the value's width bounds already
  // cover the channel.
  #narrowTrackedValue(channel: GprChannel, value: ValueId, signed: boolean): ValueId {
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
