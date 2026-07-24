import type { X86Flag } from "#core/flags/definitions.js";
import { flagStateFields } from "#core/flags/layout.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { StateFieldTracker } from "./field-tracker.js";

export class InstructionFlagState {
  readonly #state: StateFieldTracker;

  constructor(state: StateFieldTracker) {
    this.#state = state;
  }

  read(access: BoundStateAccess, flag: X86Flag): ValueId {
    return this.#state.read(access, flagStateFields.concrete[flag]);
  }

  write(flag: X86Flag, value: ValueId): void {
    this.#state.write(flagStateFields.concrete[flag], value);
  }
}
