import { instructionCountChannel } from "../../slots.js";
import type { ValueId, ValueTable } from "../../values.js";
import type { StateCells } from "./cells.js";

// Folds a run of increments into one add: the count cell holds `base +
// completed`. Anything that changes the cell outside increment() re-anchors the
// fold via #rebase, so a stale base is never reused.
export class InstructionCountState {
  readonly #values: ValueTable;
  readonly #cells: StateCells;
  #base: ValueId | undefined;
  #completed = 0;

  constructor(values: ValueTable, cells: StateCells) {
    this.#values = values;
    this.#cells = cells;
  }

  read(): ValueId {
    return this.#cells.read(instructionCountChannel);
  }

  increment(): void {
    this.#completed += 1;
    this.#cells.write(instructionCountChannel, this.#advancedValue());
  }

  add(value: ValueId): void {
    this.#cells.write(instructionCountChannel, this.#values.binary("add", this.read(), value));
    this.#rebase();
  }

  #rebase(): void {
    this.#base = undefined;
    this.#completed = 0;
  }

  #advancedValue(): ValueId {
    this.#base ??= this.#cells.read(instructionCountChannel);

    return this.#values.binary(
      "add",
      this.#base,
      this.#values.const(this.#completed)
    );
  }
}
