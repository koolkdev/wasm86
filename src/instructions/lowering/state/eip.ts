import { coreStateFields } from "#core/state/layout.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { StateFieldTracker } from "./field-tracker.js";

export class EipState {
  readonly #state: StateFieldTracker;

  constructor(state: StateFieldTracker) {
    this.#state = state;
  }

  read(access: BoundStateAccess): ValueId {
    return this.#state.read(access, coreStateFields.eip);
  }

  write(value: ValueId): void {
    this.#state.write(coreStateFields.eip, value);
  }

  has(): boolean {
    return this.#state.has(coreStateFields.eip);
  }

}
