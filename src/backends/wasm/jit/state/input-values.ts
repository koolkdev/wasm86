import {
  jitInputAluFlagsValue,
  jitInputReg32Value
} from "#backends/wasm/jit/ir/values/builders.js";
import type { Reg32 } from "#x86/types.js";
import type {
  JitCanonicalInputSlot,
  JitInputValue
} from "#backends/wasm/jit/ir/values/types.js";

export type InputValues = Readonly<{
  canonical(slot: JitCanonicalInputSlot): JitInputValue;
}>;

export function createInputValues(): InputValues {
  return new StateInputValues();
}

class StateInputValues implements InputValues {
  readonly #reg32Values = new Map<Reg32, JitInputValue>();
  #aluFlagsValue: JitInputValue | undefined;

  canonical(slot: JitCanonicalInputSlot): JitInputValue {
    switch (slot.kind) {
      case "reg32": {
        let value = this.#reg32Values.get(slot.reg);

        if (value === undefined) {
          value = jitInputReg32Value(slot.reg);
          this.#reg32Values.set(slot.reg, value);
        }

        return value;
      }
      case "aluFlags":
        if (this.#aluFlagsValue === undefined) {
          this.#aluFlagsValue = jitInputAluFlagsValue();
        }

        return this.#aluFlagsValue;
    }
  }
}
