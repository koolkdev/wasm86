import { eipChannel } from "../../slots.js";
import type { ValueId } from "../../values.js";
import type { StateCells } from "./cells.js";

// EIP is a single exact cell; this facet just names the channel for callers.
export class EipState {
  readonly #cells: StateCells;

  constructor(cells: StateCells) {
    this.#cells = cells;
  }

  read(): ValueId {
    return this.#cells.read(eipChannel);
  }

  write(value: ValueId): void {
    this.#cells.write(eipChannel, value);
  }

  has(): boolean {
    return this.#cells.has(eipChannel);
  }

  invalidate(): void {
    this.#cells.invalidate(eipChannel);
  }
}
