import { assert } from "#common/assert.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import type { StateWriteAction } from "../../actions.js";
import {
  channelCovers,
  channelsOverlap,
  gprChannel,
  type GprDynamicSlot,
  type GprChannel
} from "../../slots.js";
import {
  fitsUnsigned,
  signExtended,
  type ValueId,
  type ValueTable,
  type WidthBounds
} from "../../values.js";
import { StateAccess } from "./access.js";
import { PendingBuffer, type StatePathKind } from "./pending-buffer.js";

export type GprReadOptions = Readonly<{ signed?: boolean }>;

// GPRs have byte aliases and dynamic register slots, so they need overlap
// rules the exact state cells do not. The pending buffer holds the
// transactional writes; the overlap policy, clean-read caches, and
// unrestorable-store tracking are GPR-specific and live here.
export class GprState {
  readonly #values: ValueTable;
  readonly #state: StateAccess;
  readonly #buffer = new PendingBuffer<GprChannel>();
  readonly #reads = new Map<GprChannel, ValueId>();
  readonly #signedReads = new Map<GprChannel, ValueId>();
  #unrestorableStore = false;

  constructor(values: ValueTable, state: StateAccess) {
    this.#values = values;
    this.#state = state;
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

    return this.#state.read(slot, gprReadBounds(slot.byteLength, signed), signed);
  }

  writeDynamic(slot: GprDynamicSlot, value: ValueId): void {
    this.#flushDirty();
    this.#state.write(slot, value);
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

    const output = this.#state.read(channel, gprReadBounds(channel.byteLength, signed), signed);

    cache.set(channel, output);
    return output;
  }

  #writeChannel(channel: GprChannel, value: ValueId): void {
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

    this.#state.write(channel, entry.value);
    this.#buffer.markClean(channel);
    this.#invalidateReadsOverlapping(channel);
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
