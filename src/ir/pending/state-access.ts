import type { Action, StateSlot } from "../actions.js";
import type { EipChannel, FlagChannel, InstructionCountChannel, LazyFlagsChannel } from "../slots.js";
import type { ValueId, ValueTable, WidthBounds } from "../values.js";

export type CachedStateInput = FlagChannel | EipChannel | InstructionCountChannel | LazyFlagsChannel;

export class PendingStateAccess {
  readonly #values: ValueTable;
  readonly #emit: (action: Action) => void;
  readonly #inputReads = new Map<CachedStateInput, ValueId>();

  constructor(values: ValueTable, emit: (action: Action) => void) {
    this.#values = values;
    this.#emit = emit;
  }

  read(slot: StateSlot, bounds?: WidthBounds, signed = false): ValueId {
    const output = this.#values.addActionOutput(bounds);

    this.#emit(
      signed
        ? { kind: "readState", output, slot, signed: true }
        : { kind: "readState", output, slot }
    );
    return output;
  }

  readInput(slot: CachedStateInput, bounds?: WidthBounds): ValueId {
    const cached = this.#inputReads.get(slot);

    if (cached !== undefined) {
      return cached;
    }

    const output = this.read(slot, bounds);

    this.#inputReads.set(slot, output);
    return output;
  }

  cachedInput(slot: CachedStateInput): ValueId | undefined {
    return this.#inputReads.get(slot);
  }

  invalidateInput(slot: CachedStateInput): void {
    this.#inputReads.delete(slot);
  }

  write(slot: StateSlot, value: ValueId): void {
    this.#emit({ kind: "writeState", slot, value });
  }
}
