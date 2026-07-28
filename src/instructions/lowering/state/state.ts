import { assert } from "#common/assert.js";
import type { ResourceWriteArgs } from "#compiler/ir/operations/resource.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { ResourceEffect } from "#compiler/ir/resource.js";
import type { FieldRef } from "#compiler/layout/handles.js";
import { type BoundStateAccess, type StateAccess } from "#core/state/access.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { StatusFlagTracker } from "#core/flags/lazy/tracker.js";
import type { StatusFlagResolverFamily } from "#core/flags/lazy/resolvers.js";
import { StateFieldTracker } from "./field-tracker.js";
import type { InstructionStateChannel } from "./channels.js";
import type { StatePathKind } from "./pending-buffer.js";
import { EipState } from "./eip.js";
import { InstructionFlagState } from "./flags.js";
import { GprState } from "./gpr.js";
import { InstructionCountState } from "./instruction-count.js";
import { SegmentState } from "./segments.js";
import type { StateWriteObserver, StateWriteObserverCheckpoint } from "./write-log.js";
import { covers, mayAlias } from "#compiler/ir/effects.js";

type InstructionStateSnapshot = Readonly<{
  gpr: ReturnType<GprState["snapshot"]>;
  fields: ReturnType<StateFieldTracker["snapshot"]>;
  statusFlags: ReturnType<StatusFlagTracker["snapshot"]>;
  segments: ReturnType<SegmentState["snapshot"]>;
  instructionCount: ReturnType<InstructionCountState["snapshot"]>;
  writeObserver: StateWriteObserverCheckpoint | undefined;
}>;

export class InstructionState {
  readonly #stateAccess: StateAccess;
  readonly #fields: StateFieldTracker;
  readonly #instructionCountField: FieldRef<"u32">;
  readonly #writeObserver: StateWriteObserver | undefined;

  readonly gpr: GprState;
  readonly flags: InstructionFlagState;
  readonly statusFlags: StatusFlagTracker;
  readonly segments: SegmentState;
  readonly eip: EipState;
  readonly instructionCount: InstructionCountState;
  constructor(
    stateAccess: StateAccess,
    statusFlagResolvers: StatusFlagResolverFamily,
    instructionCountField: FieldRef<"u32">,
    writeObserver?: StateWriteObserver
  ) {
    this.#instructionCountField = instructionCountField;
    this.#writeObserver = writeObserver;
    this.#stateAccess = stateAccess;
    this.#fields = new StateFieldTracker(stateAccess, writeObserver);

    this.gpr = new GprState(stateAccess, writeObserver);
    this.flags = new InstructionFlagState(this.#fields);
    this.statusFlags = new StatusFlagTracker(
      this.#fields,
      (context, flag) => {
        const target = statusFlagResolvers.get(flag);

        this.#fields.publishForReads(context.access, target.effects.reads);
        const [resolved] = context.region.call(target, []);

        assert(resolved !== undefined, `status-flag resolver for ${flag} has no result`);
        return resolved;
      },
      () => writeObserver?.recordStatusFlagSourceWrite()
    );
    this.segments = new SegmentState(this.#fields);
    this.eip = new EipState(this.#fields);
    this.instructionCount = new InstructionCountState(this.#fields, instructionCountField);
  }

  bind(region: RegionBuilder): BoundStateAccess {
    return this.#stateAccess.bind(region);
  }

  beginInstruction(eip: ValueId): void {
    this.segments.beginInstruction();
    this.eip.write(eip);
    this.beginInstructionBoundary();
  }

  beginInstructionBoundary(): void {
    this.gpr.beginInstruction();
    this.#fields.beginInstruction();
  }

  flushesForPath(access: BoundStateAccess, path: StatePathKind): readonly ResourceWriteArgs[] {
    return [...this.gpr.flushesForPath(access, path), ...this.#fields.flushesForPath(access, path)];
  }

  enterScope<T>(build: () => T): T {
    const snapshot = this.#snapshot();

    try {
      return build();
    } finally {
      this.#restore(snapshot);
    }
  }

  invalidate(channel: InstructionStateChannel): void {
    if (channel.kind === "gpr") {
      this.gpr.invalidate(channel);
      return;
    }
    if (channel === this.#instructionCountField) {
      this.instructionCount.invalidate();
      return;
    }

    this.#fields.invalidate(channel);
  }

  readChannel(access: BoundStateAccess, channel: InstructionStateChannel): ValueId {
    return channel.kind === "gpr"
      ? this.gpr.readChannel(access, channel)
      : this.#fields.read(access, channel);
  }

  isChannelDirty(channel: InstructionStateChannel): boolean {
    return channel.kind === "gpr"
      ? this.gpr.isChannelDirty(channel)
      : this.#fields.isDirty(channel);
  }

  writeChannel(access: BoundStateAccess, channel: InstructionStateChannel, value: ValueId): void {
    switch (channel.kind) {
      case "gpr":
        this.gpr.writeChannel(access, channel, value);
        return;
      case "segment":
        assert(false, "segment writes must use a segment-load host exit");
      case "field":
        assert(
          channel !== this.#instructionCountField,
          "the instruction count changes only through InstructionCountState"
        );
        this.#fields.write(channel, value);
        return;
    }
  }

  writeback(
    access: BoundStateAccess,
    channel: InstructionStateChannel,
    value: ValueId
  ): ResourceWriteArgs {
    return channel.kind === "gpr"
      ? this.gpr.writeback(access, channel, value)
      : this.#fields.writeback(access, channel, value);
  }

  effect(channel: InstructionStateChannel): ResourceEffect {
    return channel.kind === "gpr" ? this.gpr.effect(channel) : this.#fields.effect(channel);
  }

  owns(effect: ResourceEffect): boolean {
    return this.#stateAccess.owns(effect);
  }

  channelsOverlap(a: InstructionStateChannel, b: InstructionStateChannel): boolean {
    return mayAlias(this.effect(a), this.effect(b));
  }

  channelCovers(covering: InstructionStateChannel, covered: InstructionStateChannel): boolean {
    return covers(this.effect(covering), this.effect(covered));
  }

  sameChannel(a: InstructionStateChannel, b: InstructionStateChannel): boolean {
    return this.channelCovers(a, b) && this.channelCovers(b, a);
  }

  dedupeDisjointChannels(
    input: readonly InstructionStateChannel[]
  ): readonly InstructionStateChannel[] {
    const channels: InstructionStateChannel[] = [];

    for (const channel of input) {
      if (channels.some((existing) => this.sameChannel(existing, channel))) {
        continue;
      }

      assert(
        channels.every((existing) => !this.channelsOverlap(existing, channel)),
        "overlapping state channels are unsupported"
      );
      channels.push(channel);
    }

    return channels;
  }

  #snapshot(): InstructionStateSnapshot {
    return {
      gpr: this.gpr.snapshot(),
      fields: this.#fields.snapshot(),
      statusFlags: this.statusFlags.snapshot(),
      segments: this.segments.snapshot(),
      instructionCount: this.instructionCount.snapshot(),
      writeObserver: this.#writeObserver?.checkpoint()
    };
  }

  #restore(snapshot: InstructionStateSnapshot): void {
    this.gpr.restore(snapshot.gpr);
    this.#fields.restore(snapshot.fields);
    this.statusFlags.restore(snapshot.statusFlags);
    this.segments.restore(snapshot.segments);
    this.instructionCount.restore(snapshot.instructionCount);

    if (snapshot.writeObserver !== undefined) {
      this.#writeObserver?.restore(snapshot.writeObserver);
    }
  }
}
