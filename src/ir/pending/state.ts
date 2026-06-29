import type { Action, EdgeFlushAction, GprDynamicSlot } from "../actions.js";
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
  type StateChannel
} from "../slots.js";
import type { ValueId, ValueTable } from "../values.js";
import { PendingStateAccess } from "./state-access.js";

export type PendingEdgeKind = "fault" | "completed";

export class PendingState {
  readonly #cells: PendingCells<FlagChannel | SegmentChannel | EipChannel | InstructionCountChannel | LazyFlagsChannel>;
  readonly #gprs: PendingGprs;

  constructor(values: ValueTable, emit: (action: Action) => void) {
    const state = new PendingStateAccess(values, emit);

    this.#cells = new PendingCells(state);
    this.#gprs = new PendingGprs(values, state);
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
      case "segment":
      case "eip":
      case "instructionCount":
      case "lazyFlags":
        this.#cells.write(channel, value);
        break;
    }
  }

  invalidate(channel: FlagChannel | SegmentChannel | EipChannel | InstructionCountChannel | LazyFlagsChannel): void {
    this.#cells.invalidate(channel);
  }

  readDynamicGpr(slot: GprDynamicSlot, options?: PendingReadOptions): ValueId {
    return this.#gprs.readDynamic(slot, options);
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

  flushesForEdge(edge: PendingEdgeKind): readonly EdgeFlushAction[] {
    return [
      ...this.#gprs.flushesForEdge(edge),
      ...this.#cells.flushesForEdge(edge)
    ];
  }
}
