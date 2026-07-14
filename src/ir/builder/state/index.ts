import { assert } from "#common/assert.js";
import type { StateWriteAction } from "../../actions.js";
import type { BodyBuilder } from "../../body-builder.js";
import {
  type StateChannel
} from "../../slots.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { StateCells } from "./cells.js";
import type { StatePathKind } from "./pending-buffer.js";
import { EipState } from "./eip.js";
import { FlagState } from "./flags.js";
import { GprState } from "./gpr.js";
import { InstructionCountState } from "./instruction-count.js";
import { SegmentState } from "./segments.js";
import { StatusFlagState } from "./status-flags.js";
import { VarState } from "./vars.js";
import type { StateWriteObserver, StateWriteObserverCheckpoint } from "./write-log.js";

type StateSnapshot = Readonly<{
  gpr: ReturnType<GprState["snapshot"]>;
  cells: ReturnType<StateCells["snapshot"]>;
  statusFlags: ReturnType<StatusFlagState["snapshot"]>;
  segments: ReturnType<SegmentState["snapshot"]>;
  instructionCount: ReturnType<InstructionCountState["snapshot"]>;
  writeObserver: StateWriteObserverCheckpoint | undefined;
}>;

export class State {
  readonly #cells: StateCells;
  readonly #writeObserver: StateWriteObserver | undefined;

  readonly gpr: GprState;
  readonly flags: FlagState;
  readonly statusFlags: StatusFlagState;
  readonly segments: SegmentState;
  readonly eip: EipState;
  readonly instructionCount: InstructionCountState;
  readonly vars: VarState;

  constructor(values: ValueTable, currentBody: () => BodyBuilder, writeObserver?: StateWriteObserver) {
    this.#writeObserver = writeObserver;
    this.#cells = new StateCells(currentBody, writeObserver);

    this.gpr = new GprState(values, currentBody, writeObserver);
    this.flags = new FlagState(this.#cells);
    this.statusFlags = new StatusFlagState(values, this.#cells, currentBody, writeObserver);
    this.segments = new SegmentState(values, this.#cells, currentBody);
    this.eip = new EipState(this.#cells);
    this.instructionCount = new InstructionCountState(values, this.#cells);
    this.vars = new VarState();
  }

  beginInstruction(eip: ValueId): void {
    this.vars.beginInstruction();
    this.segments.beginInstruction();
    this.eip.write(eip);
    this.beginInstructionBoundary();
  }

  beginInstructionBoundary(): void {
    this.gpr.beginInstruction();
    this.#cells.beginInstruction();
  }

  flushesForPath(path: StatePathKind): readonly StateWriteAction[] {
    return [
      ...this.gpr.flushesForPath(path),
      ...this.#cells.flushesForPath(path)
    ];
  }

  takeEipForDispatch(): ValueId {
    const targetEip = this.eip.read();

    this.eip.invalidate();
    return targetEip;
  }

  enterScope<T>(build: () => T): T {
    const snapshot = this.#snapshot();

    try {
      return build();
    } finally {
      this.#restore(snapshot);
    }
  }

  invalidate(channel: StateChannel): void {
    switch (channel.kind) {
      case "gpr":
        this.gpr.invalidate(channel);
        return;
      case "instructionCount":
        this.instructionCount.invalidate();
        return;
      case "flag":
      case "segment":
      case "eip":
      case "lazyFlags":
        this.#cells.invalidate(channel);
        return;
    }
  }

  readChannel(channel: StateChannel): ValueId {
    return channel.kind === "gpr"
      ? this.gpr.readChannel(channel)
      : this.#cells.read(channel);
  }

  isChannelDirty(channel: StateChannel): boolean {
    return channel.kind === "gpr"
      ? this.gpr.isChannelDirty(channel)
      : this.#cells.isDirty(channel);
  }

  writeChannel(channel: StateChannel, value: ValueId): void {
    switch (channel.kind) {
      case "gpr":
        this.gpr.writeChannel(channel, value);
        return;
      case "instructionCount":
        assert(false, "the instruction count changes only through InstructionCountState");
      case "flag":
      case "eip":
      case "lazyFlags":
        this.#cells.write(channel, value);
        return;
      case "segment":
        assert(false, "segment writes must use a segment-load host exit");
    }
  }

  #snapshot(): StateSnapshot {
    return {
      gpr: this.gpr.snapshot(),
      cells: this.#cells.snapshot(),
      statusFlags: this.statusFlags.snapshot(),
      segments: this.segments.snapshot(),
      instructionCount: this.instructionCount.snapshot(),
      writeObserver: this.#writeObserver?.checkpoint()
    };
  }

  #restore(snapshot: StateSnapshot): void {
    this.gpr.restore(snapshot.gpr);
    this.#cells.restore(snapshot.cells);
    this.statusFlags.restore(snapshot.statusFlags);
    this.segments.restore(snapshot.segments);
    this.instructionCount.restore(snapshot.instructionCount);

    if (snapshot.writeObserver !== undefined) {
      this.#writeObserver?.restore(snapshot.writeObserver);
    }
  }
}
