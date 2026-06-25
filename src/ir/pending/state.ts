import type { SimpleFlagSource } from "#x86/flag-sources.js";
import type { ConditionCode } from "#x86/conditions.js";
import type { X86Flag } from "#x86/flags.js";
import type { Action, EdgeFlushAction, GprDynamicSlot } from "../actions.js";
import {
  PendingCells
} from "./cells.js";
import {
  PendingFlags
} from "./flags.js";
import {
  PendingGprs,
  type PendingReadOptions
} from "./gprs.js";
import {
  type EipChannel,
  type InstructionCountChannel,
  type LazyFlagsChannel,
  type StateChannel
} from "../slots.js";
import type { ValueId, ValueTable } from "../values.js";
import { PendingStateAccess } from "./state-access.js";

export type PendingEdgeKind = "fault" | "completed";

export class PendingState {
  readonly #cells: PendingCells<EipChannel | InstructionCountChannel | LazyFlagsChannel>;
  readonly #gprs: PendingGprs;
  readonly #flags: PendingFlags;

  constructor(values: ValueTable, emit: (action: Action) => void) {
    const state = new PendingStateAccess(values, emit);

    this.#cells = new PendingCells(state);
    this.#gprs = new PendingGprs(values, state);
    this.#flags = new PendingFlags(values, state);
  }

  read(channel: StateChannel, options?: PendingReadOptions): ValueId {
    switch (channel.kind) {
      case "gpr":
        return this.#gprs.read(channel, options);
      case "flag":
        return this.#flags.readFlag(channel.flag);
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
        this.#flags.writeFlag(channel.flag, value);
        break;
      case "eip":
      case "instructionCount":
      case "lazyFlags":
        this.#cells.write(channel, value);
        break;
    }
  }

  readDynamicGpr(slot: GprDynamicSlot, options?: PendingReadOptions): ValueId {
    return this.#gprs.readDynamic(slot, options);
  }

  writeDynamicGpr(slot: GprDynamicSlot, value: ValueId): void {
    this.#gprs.writeDynamic(slot, value);
  }

  readFlag(flag: X86Flag): ValueId {
    return this.#flags.readFlag(flag);
  }

  condition(cc: ConditionCode): ValueId {
    return this.#flags.condition(cc);
  }

  writeFlag(flag: X86Flag, value: ValueId): void {
    this.#flags.writeFlag(flag, value);
  }

  writeStatusFlagsSource(source: SimpleFlagSource<ValueId>): void {
    this.#flags.writeStatusFlagsSource(source);
  }

  has(channel: StateChannel): boolean {
    switch (channel.kind) {
      case "gpr":
        return this.#gprs.has(channel);
      case "flag":
        return this.#flags.has(channel.flag);
      case "eip":
      case "instructionCount":
      case "lazyFlags":
        return this.#cells.has(channel);
    }
  }

  beginInstruction(): void {
    this.#gprs.beginInstruction();
    this.#cells.beginInstruction();
    this.#flags.beginInstruction();
  }

  flushesForEdge(edge: PendingEdgeKind): readonly EdgeFlushAction[] {
    return [
      ...this.#gprs.flushesForEdge(edge),
      ...this.#cells.flushesForEdge(edge),
      ...this.#flags.flushesForEdge(edge)
    ];
  }
}
