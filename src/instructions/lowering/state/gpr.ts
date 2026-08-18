import { assert } from "#common/assert.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { AnyNarrowInteger, Integer, BitValue, I32Value } from "#compiler/function/values.js";
import type { OperandWidth, RegName, RegisterWidth } from "#core/types.js";
import { registerAlias } from "#core/registers.js";
import { gprChannel, type GprChannel } from "#core/state/channels.js";
import type { BoundStateAccess, StateAccess } from "#core/state/access.js";
import { covers, mayAlias } from "#compiler/function/storage.js";
import { PendingBuffer, type PendingBufferSnapshot, type StatePathKind } from "./pending-buffer.js";
import type { StateWriteObserver } from "./write-log.js";
import { stateWriteback, type StateWriteback } from "./writeback.js";

type GprValue = Exclude<AnyNarrowInteger, BitValue>;

type GprStateSnapshot = Readonly<{
  buffer: PendingBufferSnapshot<GprChannel, GprValue>;
  reads: ReadonlyMap<GprChannel, GprValue>;
  unrestorableStore: boolean;
}>;

// GPR channels can alias. Pending values and cached inputs retain the exact
// channel width.
export class GprState {
  readonly #stateAccess: StateAccess;
  readonly #buffer = new PendingBuffer<GprChannel, GprValue>();
  readonly #reads = new Map<GprChannel, GprValue>();
  readonly #writeObserver: StateWriteObserver | undefined;
  #unrestorableStore = false;

  constructor(stateAccess: StateAccess, writeObserver?: StateWriteObserver) {
    this.#stateAccess = stateAccess;
    this.#writeObserver = writeObserver;
  }

  read<Width extends OperandWidth>(
    access: BoundStateAccess,
    reg: RegName | GprChannel,
    accessWidth: Width
  ): Integer<Width>;
  read<Name extends RegName>(
    access: BoundStateAccess,
    reg: Name | GprChannel<Name>
  ): Integer<RegisterWidth<Name>>;
  read(
    access: BoundStateAccess,
    reg: RegName | GprChannel,
    accessWidth?: OperandWidth
  ): GprValue | Integer<OperandWidth> {
    const channel = this.#channel(reg);

    if (accessWidth !== undefined) {
      this.#assertAccessWidth("get from", channel, accessWidth);
    }

    return this.#readChannel(access, channel);
  }

  write<Width extends OperandWidth>(
    access: BoundStateAccess,
    reg: RegName | GprChannel,
    value: Integer<Width>,
    accessWidth?: NoInfer<Width>
  ): void;
  write(
    access: BoundStateAccess,
    reg: RegName | GprChannel,
    value: GprValue,
    accessWidth?: OperandWidth
  ): void {
    const channel = this.#channel(reg);

    this.#assertAccessWidth("set to", channel, accessWidth);
    this.#writeChannel(access, channel, value);
  }

  readDynamic<Width extends OperandWidth>(
    access: BoundStateAccess,
    index: Integer<8>,
    width: Width
  ): Integer<Width> {
    this.#flushDirty(access);

    return access.read(access.dynamicGpr(index, width));
  }

  writeDynamic<Width extends OperandWidth>(
    access: BoundStateAccess,
    index: Integer<8>,
    width: Width,
    value: Integer<NoInfer<Width>>
  ): void {
    this.#flushDirty(access);
    const operand = access.dynamicGpr(index, width);

    access.write(operand, value);
    this.#unrestorableStore = true;
    this.#buffer.clear();
    this.#reads.clear();
  }

  readChannel(access: BoundStateAccess, channel: GprChannel): GprValue {
    return this.#readChannel(access, channel);
  }

  writeChannel(access: BoundStateAccess, channel: GprChannel, value: I32Value): void {
    this.#writeChannel(access, channel, channelValue(channel, value));
  }

  #readChannel(access: BoundStateAccess, channel: GprChannel): GprValue {
    const exact = this.#buffer.get(channel);

    if (exact !== undefined) {
      return this.#readTrackedValue(channel, exact.value);
    }

    for (const [other] of this.#buffer.entries()) {
      if (this.#overlaps(other, channel)) {
        this.#flush(access, other);
      }
    }

    const cached = this.#reads.get(channel);

    if (cached !== undefined) {
      return cached;
    }

    const output = this.#readState(access, channel);

    this.#reads.set(channel, output);
    return output;
  }

  #writeChannel(access: BoundStateAccess, channel: GprChannel, value: GprValue): void {
    const channelWidth = registerAlias(channel.reg).width;

    assert(channelWidth === value.width, `${channel.reg} cannot retain ${value.width}-bit state`);
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

    if (this.#isInputRestore(access, channel, value)) {
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
      unrestorableStore: this.#unrestorableStore
    };
  }

  restore(snapshot: GprStateSnapshot): void {
    this.#buffer.restore(snapshot.buffer);
    this.#reads.clear();

    for (const [channel, value] of snapshot.reads) {
      this.#reads.set(channel, value);
    }

    this.#unrestorableStore = snapshot.unrestorableStore;
  }

  flushesForPath(access: BoundStateAccess, path: StatePathKind): readonly StateWriteback[] {
    if (path === "fault") {
      assert(
        !this.#unrestorableStore,
        "a store this instruction overwrote bytes absent from the boundary snapshot; the pre-instruction state is unrestorable"
      );
    }

    return this.#buffer
      .entriesForPath(path)
      .map(([channel, value]) => this.#exactWriteback(access, channel, value));
  }

  writeback(access: BoundStateAccess, channel: GprChannel, value: I32Value): StateWriteback {
    return this.#exactWriteback(access, channel, channelValue(channel, value));
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
      const cached = this.#reads.get(channel);

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

  #readState(access: BoundStateAccess, channel: GprChannel): GprValue {
    switch (registerAlias(channel.reg).width) {
      case 8:
        return access.read(access.gprChannel(channel, 8));
      case 16:
        return access.read(access.gprChannel(channel, 16));
      case 32:
        return access.read(access.gprChannel(channel, 32));
    }
  }

  #writeState(access: BoundStateAccess, channel: GprChannel, value: GprValue): void {
    switch (value.width) {
      case 8:
        access.write(access.gprChannel(channel, 8), value);
        return;
      case 16:
        access.write(access.gprChannel(channel, 16), value);
        return;
      case 32:
        access.write(access.gprChannel(channel, 32), value);
        return;
    }
  }

  #flushDirty(access: BoundStateAccess): void {
    for (const [channel] of this.#buffer.entries()) {
      this.#flush(access, channel);
    }
  }

  #invalidateReadsOverlapping(channel: GprChannel): void {
    for (const cached of this.#reads.keys()) {
      if (this.#overlaps(cached, channel)) {
        this.#reads.delete(cached);
      }
    }
  }

  #isInputRestore(access: BoundStateAccess, channel: GprChannel, value: GprValue): boolean {
    const read = this.#reads.get(channel);

    return read !== undefined && access.sameValue(read, value);
  }

  #overlaps(a: GprChannel, b: GprChannel): boolean {
    return mayAlias(this.#stateAccess.gprEffect(a), this.#stateAccess.gprEffect(b));
  }

  #covers(covering: GprChannel, covered: GprChannel): boolean {
    return covers(this.#stateAccess.gprEffect(covering), this.#stateAccess.gprEffect(covered));
  }

  #channel(reg: RegName | GprChannel): GprChannel {
    return typeof reg === "string" ? gprChannel(reg) : reg;
  }

  #assertAccessWidth(
    verb: "get from" | "set to",
    channel: GprChannel,
    accessWidth: OperandWidth | undefined
  ): void {
    if (accessWidth === undefined) {
      return;
    }
    const channelWidth = registerAlias(channel.reg).width;

    assert(
      channelWidth === accessWidth,
      `${accessWidth}-bit ${verb} a ${channelWidth}-bit register channel`
    );
  }

  #readTrackedValue(channel: GprChannel, value: GprValue): GprValue {
    assert(
      registerAlias(channel.reg).width === value.width,
      `${channel.reg} retained ${value.width}-bit state`
    );
    return value;
  }

  #exactWriteback(access: BoundStateAccess, channel: GprChannel, value: GprValue): StateWriteback {
    switch (value.width) {
      case 8:
        return stateWriteback(access.gprChannel(channel, 8), value);
      case 16:
        return stateWriteback(access.gprChannel(channel, 16), value);
      case 32:
        return stateWriteback(access.gprChannel(channel, 32), value);
    }
  }
}

function channelValue(channel: GprChannel, value: I32Value): GprValue {
  switch (registerAlias(channel.reg).width) {
    case 8:
      return value.truncate(8);
    case 16:
      return value.truncate(16);
    case 32:
      return value;
  }
}

export function gprValueAsI32(value: GprValue): I32Value {
  switch (value.width) {
    case 8:
      return value.unsigned.extend(32);
    case 16:
      return value.unsigned.extend(32);
    case 32:
      return value;
  }
}
