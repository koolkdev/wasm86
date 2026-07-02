import { assert } from "#common/assert.js";
import type { X86StatusFlag } from "#x86/flags.js";
import type { Action, StateWriteAction } from "../actions.js";
import {
  PendingCells
} from "./cells.js";
import {
  PendingGprs,
  type PendingReadOptions
} from "./gprs.js";
import {
  type EipChannel,
  type FlagChannel,
  type InstructionCountChannel,
  type LazyFlagsChannel,
  type SegmentChannel,
  type GprDynamicSlot,
  type StateChannel
} from "../slots.js";
import { fitsUnsigned, type ValueId, type ValueTable } from "../values.js";
import { PendingStateAccess } from "./state-access.js";

export type PendingPathKind = "fault" | "completed";

export class PendingState {
  readonly #state: PendingStateAccess;
  readonly #cells: PendingCells<FlagChannel | SegmentChannel | EipChannel | InstructionCountChannel | LazyFlagsChannel>;
  readonly #gprs: PendingGprs;

  constructor(values: ValueTable, emit: (action: Action) => void) {
    this.#state = new PendingStateAccess(values, emit);

    this.#cells = new PendingCells(this.#state);
    this.#gprs = new PendingGprs(values, this.#state);
  }

  read(channel: StateChannel, options?: PendingReadOptions): ValueId {
    switch (channel.kind) {
      case "gpr":
        return this.#gprs.read(channel, options);
      case "flag":
      case "segment":
      case "eip":
      case "instructionCount":
      case "lazyFlags":
        return this.#cells.read(channel);
    }
  }

  write(channel: StateChannel, value: ValueId): void {
    switch (channel.kind) {
      case "gpr":
        this.#gprs.write(channel, value);
        break;
      case "flag":
      case "eip":
      case "instructionCount":
      case "lazyFlags":
        this.#cells.write(channel, value);
        break;
      case "segment":
        assert(false, "segment writes must use a segment-load host exit");
        break;
    }
  }

  invalidate(channel: FlagChannel | SegmentChannel | EipChannel | InstructionCountChannel | LazyFlagsChannel): void {
    this.#cells.invalidate(channel);
  }

  readDynamicGpr(slot: GprDynamicSlot, options?: PendingReadOptions): ValueId {
    return this.#gprs.readDynamic(slot, options);
  }

  readDynamicSegmentBase(index: ValueId): ValueId {
    return this.#state.read({ kind: "segmentDynamic", index, field: "base" });
  }

  readDynamicSegmentSelector(index: ValueId): ValueId {
    return this.#state.read({ kind: "segmentDynamic", index, field: "selector" }, fitsUnsigned(16));
  }

  resolveFlag(flag: X86StatusFlag): ValueId {
    return this.#state.resolveFlag(flag);
  }

  writeDynamicGpr(slot: GprDynamicSlot, value: ValueId): void {
    this.#gprs.writeDynamic(slot, value);
  }

  has(channel: StateChannel): boolean {
    switch (channel.kind) {
      case "gpr":
        return this.#gprs.has(channel);
      case "flag":
      case "segment":
      case "eip":
      case "instructionCount":
      case "lazyFlags":
        return this.#cells.has(channel);
    }
  }

  beginInstruction(): void {
    this.#gprs.beginInstruction();
    this.#cells.beginInstruction();
  }

  flushesForPath(path: PendingPathKind): readonly StateWriteAction[] {
    return [
      ...this.#gprs.flushesForPath(path),
      ...this.#cells.flushesForPath(path)
    ];
  }
}
