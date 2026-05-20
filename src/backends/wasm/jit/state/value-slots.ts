import type {
  JitCanonicalInputSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import { createInputValues, type InputValues } from "./input-values.js";

export type JitValueSlotEntry = Readonly<{
  slot: JitCanonicalInputSlot;
  value: JitValue;
}>;

export type JitValueSlotReader = Readonly<{
  readCanonical(slot: JitCanonicalInputSlot): JitValue;
  differsFromInput(slot: JitCanonicalInputSlot): boolean;
}>;

export class JitValueSlots {
  readonly #inputs: InputValues;
  readonly #values: Map<JitCanonicalInputSlot, JitValueSlotEntry>;
  readonly #changedSlots: Set<JitCanonicalInputSlot>;

  constructor(
    inputs: InputValues = createInputValues(),
    values: ReadonlyMap<JitCanonicalInputSlot, JitValueSlotEntry> = new Map(),
    changedSlots: ReadonlySet<JitCanonicalInputSlot> = new Set()
  ) {
    this.#inputs = inputs;
    this.#values = new Map(values);
    this.#changedSlots = new Set(changedSlots);
  }

  readCanonical(slot: JitCanonicalInputSlot): JitValue {
    return this.#readStorage(slot);
  }

  writeCanonical(slot: JitCanonicalInputSlot, value: JitValue): void {
    this.#writeStorage(slot, value);
  }

  differsFromInput(slot: JitCanonicalInputSlot): boolean {
    return this.#changedSlots.has(this.#inputs.canonical(slot).slot);
  }

  snapshot(): JitValueSlotSnapshot {
    return new JitValueSlotSnapshot(this.#inputs, this.#values, this.#changedSlots);
  }

  #readStorage(slot: JitCanonicalInputSlot): JitValue {
    const input = this.#inputs.canonical(slot);

    return this.#values.get(input.slot)?.value ?? input;
  }

  #writeStorage(slot: JitCanonicalInputSlot, value: JitValue): void {
    const input = this.#inputs.canonical(slot);
    const storageSlot = input.slot;
    const nextValue = canonicalStateInputValue(value, storageSlot, this.#inputs);

    if (nextValue === input) {
      this.#values.delete(storageSlot);
      this.#changedSlots.delete(storageSlot);
      return;
    }

    this.#values.set(storageSlot, { slot: storageSlot, value: nextValue });
    this.#changedSlots.add(storageSlot);
  }
}

export class JitValueSlotSnapshot implements JitValueSlotReader {
  readonly #inputs: InputValues;
  readonly #values: ReadonlyMap<JitCanonicalInputSlot, JitValueSlotEntry>;
  readonly #changedSlots: ReadonlySet<JitCanonicalInputSlot>;

  constructor(
    inputs: InputValues = createInputValues(),
    values: ReadonlyMap<JitCanonicalInputSlot, JitValueSlotEntry> = new Map(),
    changedSlots: ReadonlySet<JitCanonicalInputSlot> = new Set()
  ) {
    this.#inputs = inputs;
    this.#values = new Map(values);
    this.#changedSlots = new Set(changedSlots);
  }

  readCanonical(slot: JitCanonicalInputSlot): JitValue {
    return this.#readStorage(slot);
  }

  differsFromInput(slot: JitCanonicalInputSlot): boolean {
    return this.#changedSlots.has(this.#inputs.canonical(slot).slot);
  }

  changedEntries(): readonly JitValueSlotEntry[] {
    const entries: JitValueSlotEntry[] = [];

    for (const slot of this.#changedSlots) {
      const entry = this.#values.get(slot);

      if (entry !== undefined) {
        entries.push(entry);
      }
    }

    return entries;
  }

  toMutableSlots(): JitValueSlots {
    return new JitValueSlots(this.#inputs, this.#values, this.#changedSlots);
  }

  #readStorage(slot: JitCanonicalInputSlot): JitValue {
    const input = this.#inputs.canonical(slot);

    return this.#values.get(input.slot)?.value ?? input;
  }
}

function canonicalStateInputValue(
  value: JitValue,
  slot: JitCanonicalInputSlot,
  inputs: InputValues
): JitValue {
  if (value.kind !== "input" || !canonicalInputSlotsEqual(value.slot, slot)) {
    return value;
  }

  return inputs.canonical(slot);
}

function canonicalInputSlotsEqual(left: JitCanonicalInputSlot, right: JitCanonicalInputSlot): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "reg32":
      return right.kind === "reg32" && left.reg === right.reg;
    case "aluFlags":
      return true;
  }
}
