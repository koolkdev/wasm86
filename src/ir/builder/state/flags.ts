import type { X86Flag } from "#core/flags/definitions.js";
import { flagChannel } from "../../slots.js";
import type { ValueId } from "#compiler/ir/values/types.js";
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
