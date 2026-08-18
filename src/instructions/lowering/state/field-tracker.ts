import { buildDefinition } from "#build";
import { assert } from "#common/assert.js";
import { type StorageAccess, mayAlias } from "#compiler/function/storage.js";
import type { AnyResourceAccess } from "#compiler/function/resource.js";
import type { ValueWidthForStorage } from "#compiler/function/resource.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { I32Value } from "#compiler/function/values.js";
import type { BoundStateAccess, StateAccess } from "#core/state/access.js";
import { PendingBuffer, type PendingBufferSnapshot, type StatePathKind } from "./pending-buffer.js";
import type { StateWriteObserver } from "./write-log.js";
import type { StateFieldChannel } from "./channels.js";
import { canonicalStateWriteback, type StateWriteback } from "./writeback.js";

type StateFieldTrackerSnapshot = Readonly<{
  buffer: PendingBufferSnapshot<StateFieldChannel>;
  inputReads: ReadonlyMap<StateFieldChannel, I32Value>;
}>;

type StateStorageWidth = Exclude<ValueWidthForStorage<32>, 1>;

// Tracks reads and pending writes for state fields that do not need GPR alias
// policy. Segment channels name fields of one segment-register entry.
export class StateFieldTracker {
  readonly #stateAccess: StateAccess;
  readonly #buffer = new PendingBuffer<StateFieldChannel>();
  readonly #inputReads = new Map<StateFieldChannel, I32Value>();
  readonly #writeObserver: StateWriteObserver | undefined;

  constructor(stateAccess: StateAccess, writeObserver?: StateWriteObserver) {
    this.#stateAccess = stateAccess;
    this.#writeObserver = writeObserver;
  }

  read(access: BoundStateAccess, channel: StateFieldChannel): I32Value {
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

  write(access: BoundStateAccess, channel: StateFieldChannel, value: I32Value): void {
    this.#assertNoOverlappingEntries(channel);
    this.#writeObserver?.recordStateWrite(channel);
    const input = this.#inputReads.get(channel);

    if (input !== undefined && access.sameValue(input, value)) {
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

  flushesForPath(access: BoundStateAccess, path: StatePathKind): readonly StateWriteback[] {
    return this.#buffer
      .entriesForPath(path)
      .map(([channel, value]) => this.writeback(access, channel, value));
  }

  // Generated functions read state memory directly, so publish dirty channels
  // covered by their declared reads. The buffer retains the pre-instruction
  // value needed by a fault path.
  publishForReads(access: BoundStateAccess, reads: readonly StorageAccess[]): void {
    for (const [channel, entry] of this.#buffer.entries()) {
      if (entry.dirty && reads.some((read) => mayAlias(read, this.effect(channel)))) {
        this.#publish(access, channel, entry.value);
      }
    }
  }

  writeback(access: BoundStateAccess, channel: StateFieldChannel, value: I32Value): StateWriteback {
    return canonicalStateWriteback(this.#accessFor(access, channel), value);
  }

  effect(channel: StateFieldChannel): ResourceEffect {
    switch (channel.kind) {
      case "field":
        return this.#stateAccess.fieldEffect(channel);
      case "segment":
        return this.#stateAccess.segmentEffect(channel.reg, channel.field);
    }
  }

  #readState(access: BoundStateAccess, channel: StateFieldChannel): I32Value {
    const source = this.#accessFor(access, channel);

    switch (source.valueWidth) {
      case 1:
        return access.read({ ...source, valueWidth: 1 }).unsigned.extend(32);
      case 8:
        return access.read({ ...source, valueWidth: 8 }).unsigned.extend(32);
      case 16:
        return access.read({ ...source, valueWidth: 16 }).unsigned.extend(32);
      case 32:
        return access.read({ ...source, valueWidth: 32 });
    }
  }

  #publish(access: BoundStateAccess, channel: StateFieldChannel, value: I32Value): void {
    if (!this.#buffer.boundaryHas(channel)) {
      const previous = this.#inputReads.get(channel) ?? this.#readState(access, channel);

      this.#buffer.setBoundary(channel, previous);
    }

    const destination = this.#accessFor(access, channel);

    switch (destination.valueWidth) {
      case 1:
        access.write({ ...destination, valueWidth: 1 }, value.truncate(1));
        break;
      case 8:
        access.write({ ...destination, valueWidth: 8 }, value.truncate(8));
        break;
      case 16:
        access.write({ ...destination, valueWidth: 16 }, value.truncate(16));
        break;
      case 32:
        access.write({ ...destination, valueWidth: 32 }, value);
        break;
    }
    this.#buffer.markClean(channel);
    this.#inputReads.delete(channel);
  }

  #accessFor(
    access: BoundStateAccess,
    channel: StateFieldChannel
  ): AnyResourceAccess<StateStorageWidth> {
    switch (channel.kind) {
      case "field":
        return access.field(channel) as AnyResourceAccess<StateStorageWidth>;
      case "segment":
        return access.segment(channel.reg, channel.field) as AnyResourceAccess<StateStorageWidth>;
    }
  }

  #assertNoOverlappingEntries(channel: StateFieldChannel): void {
    if (!buildDefinition.validation) {
      return;
    }
    for (const [other] of this.#buffer.entries()) {
      assert(
        other === channel || !mayAlias(this.effect(other), this.effect(channel)),
        `overlapping state field channels are unsupported: ${JSON.stringify(other)} and ${JSON.stringify(channel)}`
      );
    }
  }
}
