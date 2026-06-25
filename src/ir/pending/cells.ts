import { assert } from "#common/assert.js";
import type { X86Flag, X86StatusFlag } from "#x86/flags.js";
import {
  type FlagChannel,
  type EipChannel,
  type InstructionCountChannel
} from "../slots.js";
import {
  fitsUnsigned,
  type ValueId,
  type WidthBounds
} from "../values.js";
import { StateAccess } from "./state-access.js";

type X86NonStatusFlag = Exclude<X86Flag, X86StatusFlag>;
export type PendingCell = FlagChannel<X86NonStatusFlag> | EipChannel | InstructionCountChannel;

type PendingEntry = { value: ValueId; dirty: boolean };

// Pending cells are independent state slots that can be tracked by exact key.
export class PendingCells<TCell extends PendingCell = PendingCell> {
  readonly #state: StateAccess;
  readonly #pending = new Map<TCell, PendingEntry>();
  #boundary = new Map<TCell, ValueId>();
  #unrestorableStore = false;

  constructor(state: StateAccess) {
    this.#state = state;
  }

  read(channel: TCell): ValueId {
    const exact = this.#pending.get(channel);

    if (exact !== undefined) {
      return exact.value;
    }

    return this.#state.readInput(channel, channelReadBounds(channel));
  }

  write(channel: TCell, value: ValueId): void {
    this.#pending.set(channel, { value, dirty: true });
  }

  has(channel: TCell): boolean {
    return this.#pending.has(channel);
  }

  beginInstruction(): void {
    this.#boundary = new Map(
      [...this.#pending].map(([channel, entry]) => [channel, entry.value])
    );
    this.#unrestorableStore = false;
  }

  snapshot(): ReadonlyArray<readonly [TCell, ValueId]> {
    assert(
      !this.#unrestorableStore,
      "a store this instruction overwrote bytes absent from the boundary snapshot; the pre-instruction state is unrestorable"
    );

    return [...this.#boundary];
  }

  entries(): ReadonlyArray<readonly [TCell, ValueId]> {
    return [...this.#pending].flatMap(([channel, entry]) => (
      entry.dirty ? [[channel, entry.value] as const] : []
    ));
  }

  flushAll(): void {
    for (const [channel, entry] of this.#pending) {
      this.#flush(channel, entry);
    }
  }

  #flush(channel: TCell, entry: PendingEntry): void {
    if (!entry.dirty) {
      return;
    }

    if (!this.#boundary.has(channel)) {
      const cached = this.#state.cachedInput(channel);

      if (cached !== undefined) {
        this.#boundary.set(channel, cached);
      } else {
        this.#unrestorableStore = true;
      }
    }

    this.#state.write(channel, entry.value);
    entry.dirty = false;
    this.#state.invalidateInput(channel);
  }
}

function channelReadBounds(channel: PendingCell): WidthBounds | undefined {
  switch (channel.kind) {
    case "flag":
      return fitsUnsigned(1);
    case "eip":
    case "instructionCount":
      return undefined;
  }
}
