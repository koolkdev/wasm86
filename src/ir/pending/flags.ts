import type { SimpleFlagSource } from "#x86/flag-sources.js";
import type { ConditionCode } from "#x86/conditions.js";
import { x86StatusFlags, type X86Flag, type X86StatusFlag } from "#x86/flags.js";
import { flagChannel, type FlagChannel } from "../slots.js";
import type { ValueId, ValueTable } from "../values.js";
import { PendingCells } from "./cells.js";
import { StateAccess } from "./state-access.js";
import { PendingStatusFlags } from "./status-flags.js";

type X86NonStatusFlag = Exclude<X86Flag, X86StatusFlag>;
type NonStatusFlagCell = FlagChannel<X86NonStatusFlag>;

export type PendingFlagEntry = readonly [FlagChannel<X86Flag>, ValueId];

export class PendingFlags {
  readonly #cells: PendingCells<NonStatusFlagCell>;
  readonly #status: PendingStatusFlags;

  constructor(values: ValueTable, state: StateAccess) {
    this.#cells = new PendingCells(state);
    this.#status = new PendingStatusFlags(values, state);
  }

  readFlag(flag: X86Flag): ValueId {
    return isStatusFlag(flag)
      ? this.#status.readFlag(flag)
      : this.#cells.read(flagChannel(flag));
  }

  condition(cc: ConditionCode): ValueId {
    return this.#status.condition(cc);
  }

  writeFlag(flag: X86Flag, value: ValueId): void {
    if (isStatusFlag(flag)) {
      this.#status.writeFlag(flag, value);
    } else {
      this.#cells.write(flagChannel(flag), value);
    }
  }

  writeStatusFlagsSource(source: SimpleFlagSource<ValueId>): void {
    this.#status.writeStatusFlagsSource(source);
  }

  has(flag: X86Flag): boolean {
    return isStatusFlag(flag)
      ? this.#status.has(flag)
      : this.#cells.has(flagChannel(flag));
  }

  beginInstruction(): void {
    this.#cells.beginInstruction();
    this.#status.beginInstruction();
  }

  snapshot(): readonly PendingFlagEntry[] {
    return [...this.#cells.snapshot(), ...this.#status.snapshot()];
  }

  entries(): readonly PendingFlagEntry[] {
    return [...this.#cells.entries(), ...this.#status.entries()];
  }

  flushAll(): void {
    this.#cells.flushAll();
    this.#status.flushAll();
  }
}

function isStatusFlag(flag: X86Flag): flag is X86StatusFlag {
  return (x86StatusFlags as readonly X86Flag[]).includes(flag);
}
