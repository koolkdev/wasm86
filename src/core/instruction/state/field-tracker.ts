import { assert } from "#common/assert.js";
import type { ResourceWriteArgs } from "#compiler/ir/operations/resource.js";
import type { StorageAccess } from "#compiler/ir/effects.js";
import type {
  ResourceByteOperand,
  ResourceEffect
} from "#compiler/ir/resource.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import { type ValueId, type WidthBounds } from "#compiler/ir/values/types.js";
import { isConcreteFlagStateField } from "#core/flags/layout.js";
import { mayAlias } from "#compiler/ir/effects.js";
import type {
  BoundStateAccess,
  StateAccess
} from "#core/state/access.js";
import { PendingBuffer, type PendingBufferSnapshot, type StatePathKind } from "./pending-buffer.js";
import type { StateWriteObserver } from "./write-log.js";
import type { StateFieldChannel } from "./channels.js";

type StateFieldTrackerSnapshot = Readonly<{
  buffer: PendingBufferSnapshot<StateFieldChannel>;
  inputReads: ReadonlyMap<StateFieldChannel, ValueId>;
}>;

// Tracks reads and pending writes for state fields that do not need GPR alias
// policy. Segment channels name fields of one segment-register entry.
export class StateFieldTracker {
  readonly #stateAccess: StateAccess;
  readonly #buffer = new PendingBuffer<StateFieldChannel>();
  readonly #inputReads = new Map<StateFieldChannel, ValueId>();
  readonly #writeObserver: StateWriteObserver | undefined;

  constructor(
    stateAccess: StateAccess,
    writeObserver?: StateWriteObserver
  ) {
    this.#stateAccess = stateAccess;
    this.#writeObserver = writeObserver;
  }

  read(access: BoundStateAccess, channel: StateFieldChannel): ValueId {
    const tracked = this.#buffer.get(channel);

    if (tracked !== undefined) {
      return tracked.value;
    }

    this.#assertNoOverlappingEntries(channel);

    const cached = this.#inputReads.get(channel);

    if (cached !== undefined) {
      return cached;
    }

    const output = this.#readState(access, channel);

    this.#inputReads.set(channel, output);
    return output;
  }

  write(channel: StateFieldChannel, value: ValueId): void {
    this.#assertNoOverlappingEntries(channel);
    this.#writeObserver?.recordStateWrite(channel);

    if (this.#inputReads.get(channel) === value) {
      this.#buffer.delete(channel);
      return;
    }

    this.#buffer.set(channel, value);
  }

  invalidate(channel: StateFieldChannel): void {
    this.#buffer.delete(channel);
    this.#inputReads.delete(channel);
  }

  has(channel: StateFieldChannel): boolean {
    return this.#buffer.has(channel);
  }

  // Whether memory does not hold the channel's current value.
  isDirty(channel: StateFieldChannel): boolean {
    return this.#buffer.get(channel)?.dirty === true;
  }

  beginInstruction(): void {
    this.#buffer.snapshotBoundary();
  }

  snapshot(): StateFieldTrackerSnapshot {
    return {
      buffer: this.#buffer.snapshot(),
      inputReads: new Map(this.#inputReads)
    };
  }

  restore(snapshot: StateFieldTrackerSnapshot): void {
    this.#buffer.restore(snapshot.buffer);
    this.#inputReads.clear();

    for (const [channel, value] of snapshot.inputReads) {
      this.#inputReads.set(channel, value);
    }
  }

  flushesForPath(
    access: BoundStateAccess,
    path: StatePathKind
  ): readonly ResourceWriteArgs[] {
    return this.#buffer.entriesForPath(path).map(
      ([channel, value]) => this.writeback(access, channel, value)
    );
  }

  // A generated function reads state directly, not through this buffer. Write
  // the values covered by its declared reads before calling it. Inside an
  // if/switch arm, each write must already have an instruction-boundary value;
  // input-backed flag reset sites discard newer lazy writes first.
  publishForReads(
    access: BoundStateAccess,
    reads: readonly StorageAccess[]
  ): void {
    for (const [channel, entry] of this.#buffer.entries()) {
      if (
        entry.dirty &&
        reads.some((read) => mayAlias(read, this.effect(channel)))
      ) {
        this.#publish(access, channel, entry.value);
      }
    }
  }

  writeback(
    access: BoundStateAccess,
    channel: StateFieldChannel,
    value: ValueId
  ): ResourceWriteArgs {
    return {
      destination: this.#operandWith(access, channel),
      value
    };
  }

  effect(channel: StateFieldChannel): ResourceEffect {
    switch (channel.kind) {
      case "field":
        return this.#stateAccess.fieldEffect(channel);
      case "segment":
        return this.#stateAccess.segmentEffect(channel.reg, channel.field);
    }
  }

  #readState(
    access: BoundStateAccess,
    channel: StateFieldChannel
  ): ValueId {
    switch (channel.kind) {
      case "field":
        return access.readField(
          channel,
          isConcreteFlagStateField(channel)
            ? { kind: "unsigned", bounds: fitsUnsigned(1) }
            : undefined
        );
      case "segment":
        return access.read(access.segment(channel.reg, channel.field));
    }
  }

  #publish(
    access: BoundStateAccess,
    channel: StateFieldChannel,
    value: ValueId
  ): void {
    if (!this.#buffer.boundaryHas(channel)) {
      const previous = this.#inputReads.get(channel) ??
        this.#readState(access, channel);

      this.#buffer.setBoundary(channel, previous);
    }

    access.write(this.#operandWith(access, channel), value);
    this.#buffer.markClean(channel);
    this.#inputReads.delete(channel);
  }

  #operandWith(
    access: BoundStateAccess,
    channel: StateFieldChannel
  ): ResourceByteOperand {
    switch (channel.kind) {
      case "field":
        return access.field(channel);
      case "segment":
        return access.segment(channel.reg, channel.field);
    }
  }

  #assertNoOverlappingEntries(channel: StateFieldChannel): void {
    for (const [other] of this.#buffer.entries()) {
      assert(
        other === channel || !mayAlias(this.effect(other), this.effect(channel)),
        `overlapping state field channels are unsupported: ${JSON.stringify(other)} and ${JSON.stringify(channel)}`
      );
    }
  }
}

export function channelReadBounds(channel: StateFieldChannel): WidthBounds | undefined {
  switch (channel.kind) {
    case "segment":
      return channel.field === "selector" ? fitsUnsigned(16) : undefined;
    case "field":
      if (isConcreteFlagStateField(channel)) {
        return fitsUnsigned(1);
      }
      switch (channel.width) {
        case "u8":
          return fitsUnsigned(8);
        case "u16":
          return fitsUnsigned(16);
        case "u32":
          return undefined;
      }
  }
}
