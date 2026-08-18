import { coreStateFields } from "#core/state/layout.js";
import type { I32Value } from "#compiler/function/values.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { StateFieldTracker } from "./field-tracker.js";

export class EipState {
  readonly #state: StateFieldTracker;

  constructor(state: StateFieldTracker) {
    this.#state = state;
  }

  read(access: BoundStateAccess): I32Value {
    return this.#state.read(access, coreStateFields.eip);
  }

  write(access: BoundStateAccess, value: I32Value): void {
    this.#state.write(access, coreStateFields.eip, value);
  }

  has(): boolean {
    return this.#state.has(coreStateFields.eip);
  }
}
