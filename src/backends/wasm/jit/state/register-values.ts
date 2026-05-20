import type { Reg16, Reg32, Reg8 } from "#x86/isa/types.js";
import {
  jitExtractBits,
  jitInsertBits
} from "#backends/wasm/jit/ir/values/builders.js";
import { jitRegisterSlotAlias } from "#backends/wasm/jit/ir/values/slots.js";
import type {
  JitArchitecturalSlot,
  JitCanonicalInputSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type {
  JitValueSlotReader,
  JitValueSlotSnapshot,
  JitValueSlots
} from "./value-slots.js";

type JitReg32Slot = Extract<JitCanonicalInputSlot, { kind: "reg32" }>;
type JitReg16Slot = Extract<JitArchitecturalSlot, { kind: "reg16" }>;
type JitReg8Slot = Extract<JitArchitecturalSlot, { kind: "reg8" }>;
type JitRegisterAliasSlot = JitReg16Slot | JitReg8Slot;

export class JitRegisterValueFamily {
  #slots: JitValueSlots;

  constructor(slots: JitValueSlots) {
    this.#slots = slots;
  }

  readReg32(reg: Reg32): JitValue {
    return this.#slots.readCanonical(reg32Slot(reg));
  }

  writeReg32(reg: Reg32, value: JitValue): void {
    this.#slots.writeCanonical(reg32Slot(reg), value);
  }

  readReg16(reg: Reg16): JitValue {
    return readRegisterAlias(this.#slots, reg16Slot(reg));
  }

  writeReg16(reg: Reg16, value: JitValue): void {
    writeRegisterAlias(this.#slots, reg16Slot(reg), value);
  }

  readReg8(reg: Reg8): JitValue {
    return readRegisterAlias(this.#slots, reg8Slot(reg));
  }

  writeReg8(reg: Reg8, value: JitValue): void {
    writeRegisterAlias(this.#slots, reg8Slot(reg), value);
  }
}

export class JitRegisterValueSnapshotFamily {
  #slots: JitValueSlotSnapshot;

  constructor(slots: JitValueSlotSnapshot) {
    this.#slots = slots;
  }

  readReg32(reg: Reg32): JitValue {
    return this.#slots.readCanonical(reg32Slot(reg));
  }

  readReg16(reg: Reg16): JitValue {
    return readRegisterAlias(this.#slots, reg16Slot(reg));
  }

  readReg8(reg: Reg8): JitValue {
    return readRegisterAlias(this.#slots, reg8Slot(reg));
  }

  differsFromInput(reg: Reg32): boolean {
    return this.#slots.differsFromInput(reg32Slot(reg));
  }
}

export function reg32Slot(reg: Reg32): JitReg32Slot {
  return { kind: "reg32", reg };
}

export function reg16Slot(reg: Reg16): JitReg16Slot {
  return { kind: "reg16", reg };
}

export function reg8Slot(reg: Reg8): JitReg8Slot {
  return { kind: "reg8", reg };
}

function readRegisterAlias(slots: JitValueSlotReader, slot: JitRegisterAliasSlot): JitValue {
  const alias = jitRegisterSlotAlias(slot);

  return jitExtractBits(
    slots.readCanonical(reg32Slot(alias.base)),
    alias.bitOffset,
    alias.width
  );
}

function writeRegisterAlias(slots: JitValueSlots, slot: JitRegisterAliasSlot, value: JitValue): void {
  const alias = jitRegisterSlotAlias(slot);
  const baseSlot = reg32Slot(alias.base);
  const base = slots.readCanonical(baseSlot);

  slots.writeCanonical(
    baseSlot,
    jitInsertBits(base, value, alias.bitOffset, alias.width)
  );
}
