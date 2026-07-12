import type { X86Flag } from "#core/flags.js";
import { flagChannel } from "../../slots.js";
import type { ValueId } from "../../values.js";
import type { StateCells } from "./cells.js";

export class FlagState {
  readonly #cells: StateCells;

  constructor(cells: StateCells) {
    this.#cells = cells;
  }

  read(flag: X86Flag): ValueId {
    return this.#cells.read(flagChannel(flag));
  }

  write(flag: X86Flag, value: ValueId): void {
    this.#cells.write(flagChannel(flag), value);
  }
}
