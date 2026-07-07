import { assert } from "#common/assert.js";
import type { Action, StateWriteAction } from "../../actions.js";
import {
  type StateChannel
} from "../../slots.js";
import type { ValueId, ValueTable } from "../../values.js";
import { StateAccess } from "./access.js";
import { StateCells } from "./cells.js";
import type { StatePathKind } from "./pending-buffer.js";
import { EipState } from "./eip.js";
import { FlagState } from "./flags.js";
import { GprState } from "./gpr.js";
import { InstructionCountState } from "./instruction-count.js";
import type { StateLoopOptions } from "./loop-scope.js";
import { SegmentState, type SegmentMode, type SegmentTerminator } from "./segments.js";
import { StatusFlagState } from "./status-flags.js";

export class State {
  readonly #access: StateAccess;
  readonly #cells: StateCells;

  readonly gpr: GprState;
  readonly flags: FlagState;
  readonly statusFlags: StatusFlagState;
  readonly segments: SegmentState;
  readonly eip: EipState;
  readonly instructionCount: InstructionCountState;

  constructor(
    values: ValueTable,
    emit: (action: Action) => void,
    segmentMode: SegmentMode,
    terminate: SegmentTerminator
  ) {
    this.#access = new StateAccess(values, emit);
    this.#cells = new StateCells(this.#access);

    this.gpr = new GprState(values, this.#access);
    this.flags = new FlagState(this.#cells);
    this.statusFlags = new StatusFlagState(values, this.#cells, this.#access, emit);
    this.segments = new SegmentState(
      values,
      this.#cells,
      this.#access,
      segmentMode,
      terminate,
      () => this.flushesForPath("fault")
    );
    this.eip = new EipState(this.#cells);
    this.instructionCount = new InstructionCountState(values, this.#cells);
  }

  beginInstruction(eip: ValueId): void {
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

  flushesForCompletedDispatch(): readonly StateWriteAction[] {
    return this.flushesForPath("completed").filter((action) => action.op.slot.kind !== "eip");
  }

  takeEipForDispatch(): ValueId {
    const targetEip = this.eip.read();

    this.eip.invalidate();
    return targetEip;
  }

  invalidate(channel: StateChannel): void {
    switch (channel.kind) {
      case "gpr":
        this.gpr.invalidate(channel);
        return;
      case "instructionCount":
        assert(false, "the instruction count changes only through InstructionCountState");
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
}

export type { StateLoopOptions };
