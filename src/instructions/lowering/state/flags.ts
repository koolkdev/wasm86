import type { X86Flag } from "#core/flags/definitions.js";
import { flagStateFields } from "#core/flags/layout.js";
import { nonzero, type BitValue } from "#compiler/function/values.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { StateFieldTracker } from "./field-tracker.js";

export class InstructionFlagState {
  readonly #state: StateFieldTracker;

  constructor(state: StateFieldTracker) {
    this.#state = state;
  }

  read(access: BoundStateAccess, flag: X86Flag): BitValue {
    return nonzero(this.#state.read(access, flagStateFields.concrete[flag]));
  }

  write(access: BoundStateAccess, flag: X86Flag, value: BitValue): void {
    this.#state.write(access, flagStateFields.concrete[flag], value.unsigned.extend(32));
  }
}
