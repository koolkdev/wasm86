import type { ConditionCode } from "#ir/model/types.js";
import {
  assertIrAluFlagMask,
  IR_ALU_FLAG_MASK
} from "#ir/model/flag-effects.js";
import {
  jitExtractMaskedBits,
  jitFlagConditionValue,
  jitInsertMaskedBits
} from "#backends/wasm/jit/ir/values/builders.js";
import type {
  JitCanonicalInputSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type {
  JitValueSlotSnapshot,
  JitValueSlots
} from "./value-slots.js";

export class JitAluFlagValueFamily {
  #slots: JitValueSlots;

  constructor(slots: JitValueSlots) {
    this.#slots = slots;
  }

  readAluFlags(): JitValue {
    return this.#slots.readCanonical(aluFlagsSlot());
  }

  writeAluFlags(value: JitValue): void {
    this.#slots.writeCanonical(aluFlagsSlot(), value);
  }

  readFlagBits(mask: number): JitValue {
    assertIrAluFlagMask(mask, "JIT flag read mask");
    return readFlagBits(this.readAluFlags(), mask);
  }

  writeFlagBits(mask: number, value: JitValue): void {
    assertIrAluFlagMask(mask, "JIT flag write mask");
    if (mask === 0) {
      return;
    }

    this.writeAluFlags(writeFlagBits(this.readAluFlags(), mask, value));
  }

  condition(cc: ConditionCode): JitValue {
    return jitFlagConditionValue(this.readAluFlags(), cc);
  }
}

export class JitAluFlagValueSnapshotFamily {
  #slots: JitValueSlotSnapshot;

  constructor(slots: JitValueSlotSnapshot) {
    this.#slots = slots;
  }

  readAluFlags(): JitValue {
    return this.#slots.readCanonical(aluFlagsSlot());
  }

  readFlagBits(mask: number): JitValue {
    assertIrAluFlagMask(mask, "JIT flag snapshot read mask");
    return readFlagBits(this.readAluFlags(), mask);
  }

  condition(cc: ConditionCode): JitValue {
    return jitFlagConditionValue(this.readAluFlags(), cc);
  }

  differsFromInput(): boolean {
    return this.#slots.differsFromInput(aluFlagsSlot());
  }
}

export function aluFlagsSlot(): JitCanonicalInputSlot {
  return { kind: "aluFlags" };
}

function readFlagBits(aluFlags: JitValue, mask: number): JitValue {
  return mask === IR_ALU_FLAG_MASK
    ? aluFlags
    : jitExtractMaskedBits(aluFlags, mask);
}

function writeFlagBits(aluFlags: JitValue, mask: number, value: JitValue): JitValue {
  return mask === IR_ALU_FLAG_MASK
    ? value
    : jitInsertMaskedBits(aluFlags, value, mask);
}
