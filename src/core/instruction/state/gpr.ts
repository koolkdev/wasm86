import { assert } from "#common/assert.js";
import { resourceWrite } from "#compiler/ir/operations/resource.js";
import type { ResourceEffect } from "#compiler/ir/resource.js";
import type { OperandWidth, RegName } from "#core/types.js";
import { registerAlias } from "#core/registers.js";
import type { Action } from "#ir/actions.js";
import { gprChannel, type GprChannel } from "#core/state/channels.js";
import type {
  BoundStateAccess,
  StateAccess
} from "#core/state/access.js";
import { covers, mayAlias } from "#ir/aliasing.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import { PendingBuffer, type PendingBufferSnapshot, type StatePathKind } from "./pending-buffer.js";
import type { StateWriteObserver } from "./write-log.js";

export type GprReadOptions = Readonly<{ signed?: boolean }>;

type GprStateSnapshot = Readonly<{
  buffer: PendingBufferSnapshot<GprChannel>;
  reads: ReadonlyMap<GprChannel, ValueId>;
  signedReads: ReadonlyMap<GprChannel, ValueId>;
  unrestorableStore: boolean;
}>;

// GPR channels can alias. This tracker owns their overlap and restart rules.
export class GprState {
  readonly #values: ValueTable;
  readonly #stateAccess: StateAccess;
  readonly #buffer = new PendingBuffer<GprChannel>();
  readonly #reads = new Map<GprChannel, ValueId>();
  readonly #signedReads = new Map<GprChannel, ValueId>();
  readonly #writeObserver: StateWriteObserver | undefined;
  #unrestorableStore = false;

  constructor(
    values: ValueTable,
    stateAccess: StateAccess,
    writeObserver?: StateWriteObserver
  ) {
    this.#values = values;
    this.#stateAccess = stateAccess;
    this.#writeObserver = writeObserver;
  }

  read(
    access: BoundStateAccess,
    reg: RegName | GprChannel,
    accessWidthOrOptions?: OperandWidth | GprReadOptions,
    options: GprReadOptions = {}
  ): ValueId {
    const channel = this.#channel(reg);
    const readOptions = typeof accessWidthOrOptions === "number" ? options : accessWidthOrOptions ?? {};

    if (typeof accessWidthOrOptions === "number") {
      this.#assertAccessWidth("get from", channel, accessWidthOrOptions);
    }

    return this.#readChannel(access, channel, readOptions);
  }

  write(
    access: BoundStateAccess,
    reg: RegName | GprChannel,
    value: ValueId,
    accessWidth?: OperandWidth
  ): void {
    const channel = this.#channel(reg);

    this.#assertAccessWidth("set to", channel, accessWidth);
    this.#writeChannel(access, channel, value);
  }

  readDynamic(
    access: BoundStateAccess,
    index: ValueId,
    width: OperandWidth,
    options: GprReadOptions = {}
  ): ValueId {
    const signed = options.signed === true && width !== 32;

    this.#flushDirty(access);

    return access.read(
      access.dynamicGpr(index, width),
      signed ? { kind: "signed" } : undefined
    );
  }

  writeDynamic(
    access: BoundStateAccess,
    index: ValueId,
    width: OperandWidth,
    value: ValueId
  ): void {
    this.#flushDirty(access);
    access.write(access.dynamicGpr(index, width), value);
    this.#unrestorableStore = true;
    this.#buffer.clear();
    this.#reads.clear();
    this.#signedReads.clear();
  }

  readChannel(
    access: BoundStateAccess,
    channel: GprChannel,
    options: GprReadOptions = {}
  ): ValueId {
    return this.#readChannel(access, channel, options);
  }

  writeChannel(
    access: BoundStateAccess,
    channel: GprChannel,
    value: ValueId
  ): void {
    this.#writeChannel(access, channel, value);
  }

  #readChannel(
    access: BoundStateAccess,
    channel: GprChannel,
    options: GprReadOptions = {}
  ): ValueId {
    const signed = options.signed === true && narrowBits(channel) !== undefined;
    const exact = this.#buffer.get(channel);

    if (exact !== undefined) {
      return this.#narrowTrackedValue(channel, exact.value, signed);
    }

    for (const [other] of this.#buffer.entries()) {
      if (this.#overlaps(other, channel)) {
        this.#flush(access, other);
      }
    }

    const cache = signed ? this.#signedReads : this.#reads;
    const cached = cache.get(channel);

    if (cached !== undefined) {
      return cached;
    }

    const output = this.#readState(access, channel, signed);

    cache.set(channel, output);
    return output;
  }

  #writeChannel(
    access: BoundStateAccess,
    channel: GprChannel,
    value: ValueId
  ): void {
    this.#writeObserver?.recordStateWrite(channel);

    for (const [other] of this.#buffer.entries()) {
      if (other === channel || !this.#overlaps(other, channel)) {
        continue;
      }

      if (!this.#covers(channel, other)) {
        this.#flush(access, other);
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
      if (entry.dirty && this.#overlaps(other, channel)) {
        return true;
      }
    }

    return false;
  }

  // Drops the channel's tracked value and cached reads; the next read goes
  // back to state memory.
  invalidate(channel: GprChannel): void {
    for (const [other] of this.#buffer.entries()) {
      if (this.#overlaps(other, channel)) {
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

  flushesForPath(
    access: BoundStateAccess,
    path: StatePathKind
  ): readonly Action[] {
    if (path === "fault") {
      assert(
        !this.#unrestorableStore,
        "a store this instruction overwrote bytes absent from the boundary snapshot; the pre-instruction state is unrestorable"
      );
    }

    return this.#buffer.entriesForPath(path).map(([channel, value]) =>
      this.writeAction(access, channel, value)
    );
  }

  writeAction(
    access: BoundStateAccess,
    channel: GprChannel,
    value: ValueId
  ): Action {
    return {
      kind: "op",
      op: resourceWrite.create({
        destination: access.gprChannel(channel),
        value
      })
    };
  }

  effect(channel: GprChannel): ResourceEffect {
    return this.#stateAccess.gprEffect(channel);
  }

  #flush(access: BoundStateAccess, channel: GprChannel): void {
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

    this.#writeState(access, channel, entry.value);
    this.#buffer.markClean(channel);
    this.#invalidateReadsOverlapping(channel);
  }

  #readState(
    access: BoundStateAccess,
    channel: GprChannel,
    signed: boolean
  ): ValueId {
    return access.read(
      access.gprChannel(channel),
      signed ? { kind: "signed" } : undefined
    );
  }

  #writeState(
    access: BoundStateAccess,
    channel: GprChannel,
    value: ValueId
  ): void {
    access.write(access.gprChannel(channel), value);
  }

  #flushDirty(access: BoundStateAccess): void {
    for (const [channel] of this.#buffer.entries()) {
      this.#flush(access, channel);
    }
  }

  #invalidateReadsOverlapping(channel: GprChannel): void {
    for (const cache of [this.#reads, this.#signedReads]) {
      for (const cached of cache.keys()) {
        if (this.#overlaps(cached, channel)) {
          cache.delete(cached);
        }
      }
    }
  }

  #isInputRestore(channel: GprChannel, value: ValueId): boolean {
    return this.#reads.get(channel) === value || this.#signedReads.get(channel) === value;
  }

  #overlaps(a: GprChannel, b: GprChannel): boolean {
    return mayAlias(
      this.#stateAccess.gprEffect(a),
      this.#stateAccess.gprEffect(b)
    );
  }

  #covers(covering: GprChannel, covered: GprChannel): boolean {
    return covers(
      this.#stateAccess.gprEffect(covering),
      this.#stateAccess.gprEffect(covered)
    );
  }

  #channel(reg: RegName | GprChannel): GprChannel {
    return typeof reg === "string" ? gprChannel(reg) : reg;
  }

  #assertAccessWidth(action: "get from" | "set to", channel: GprChannel, accessWidth: OperandWidth | undefined): void {
    if (accessWidth === undefined) {
      return;
    }
    const channelWidth = registerAlias(channel.reg).width;

    assert(
      channelWidth === accessWidth,
      `${accessWidth}-bit ${action} a ${channelWidth}-bit register channel`
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
  const width = registerAlias(channel.reg).width;

  if (width === 32) {
    return undefined;
  }

  return width;
}
