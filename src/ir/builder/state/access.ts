import type { X86StatusFlag } from "#x86/flags.js";
import type { Action } from "../../actions.js";
import {
  type EipChannel,
  type FlagChannel,
  type InstructionCountChannel,
  type LazyFlagsChannel,
  type SegmentChannel,
  type StateSlot
} from "../../slots.js";
import { fitsUnsigned, type ValueId, type ValueTable, type WidthBounds } from "../../values.js";

export type CachedStateInput = FlagChannel | SegmentChannel | EipChannel | InstructionCountChannel | LazyFlagsChannel;

export class StateAccess {
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
        ? { kind: "op", output, op: { kind: "state.read", slot, signed: true } }
        : { kind: "op", output, op: { kind: "state.read", slot } }
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

  resolveFlag(flag: X86StatusFlag): ValueId {
    const output = this.#values.addActionOutput(fitsUnsigned(1));

    this.#emit({ kind: "op", output, op: { kind: "cpu.resolveFlag", flag } });
    return output;
  }

  write(slot: StateSlot, value: ValueId): void {
    this.#emit({ kind: "op", op: { kind: "state.write", slot, value } });
  }
}
