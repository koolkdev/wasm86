import type { Reg16, Reg32, Reg8 } from "#x86/isa/types.js";
import type { ConditionCode } from "#x86/ir/model/types.js";
import { IR_ALU_FLAG_MASK, assertIrAluFlagMask } from "#x86/ir/model/flag-effects.js";
import {
  jitExtractBits,
  jitExtractMaskedBits,
  jitFlagConditionValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  jitInsertMaskedBits
} from "#backends/wasm/jit/ir/values/builders.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import {
  jitRegisterSlotAlias
} from "#backends/wasm/jit/ir/values/slots.js";
import type {
  JitArchitecturalSlot,
  JitRegisterSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";

export type JitValueSlotEntry = Readonly<{
  slot: JitArchitecturalSlot;
  value: JitValue;
}>;

export class JitValueState {
  readonly slots: JitValueSlots;
  readonly regs: JitRegisterValueFamily;
  readonly flags: JitAluFlagValueFamily;

  constructor(slots = new JitValueSlots()) {
    this.slots = slots;
    this.regs = new JitRegisterValueFamily(slots);
    this.flags = new JitAluFlagValueFamily(slots);
  }

  snapshot(): JitValueStateSnapshot {
    return new JitValueStateSnapshot(this.slots.snapshot());
  }
}

export class JitValueSlots {
  readonly #values = new Map<string, JitValueSlotEntry>();

  read(slot: JitArchitecturalSlot): JitValue {
    const alias = slot.kind === "reg16" || slot.kind === "reg8"
      ? jitRegisterSlotAlias(slot)
      : undefined;

    if (alias !== undefined) {
      return jitExtractBits(this.read(reg32Slot(alias.base)), alias.bitOffset, alias.width);
    }

    return this.#values.get(jitValueSlotKey(slot))?.value ?? this.inputValue(slot);
  }

  write(slot: JitArchitecturalSlot, value: JitValue): void {
    if (slot.kind === "reg16" || slot.kind === "reg8") {
      const alias = jitRegisterSlotAlias(slot);
      const base = reg32Slot(alias.base);

      this.write(base, jitInsertBits(this.read(base), value, alias.bitOffset, alias.width));
      return;
    }

    this.#values.set(jitValueSlotKey(slot), { slot, value: simplifyValue(value) });
  }

  inputValue(slot: JitArchitecturalSlot): JitValue {
    return jitValueInputForSlot(slot);
  }

  snapshot(): JitValueSlotSnapshot {
    return new JitValueSlotSnapshot(this.#values);
  }
}

export class JitValueSlotSnapshot {
  readonly #values: ReadonlyMap<string, JitValueSlotEntry>;

  constructor(values: ReadonlyMap<string, JitValueSlotEntry> = new Map()) {
    this.#values = new Map(values);
  }

  read(slot: JitArchitecturalSlot): JitValue {
    const alias = slot.kind === "reg16" || slot.kind === "reg8"
      ? jitRegisterSlotAlias(slot)
      : undefined;

    if (alias !== undefined) {
      return jitExtractBits(this.read(reg32Slot(alias.base)), alias.bitOffset, alias.width);
    }

    return this.#values.get(jitValueSlotKey(slot))?.value ?? this.inputValue(slot);
  }

  inputValue(slot: JitArchitecturalSlot): JitValue {
    return jitValueInputForSlot(slot);
  }

  differsFromInput(slot: JitArchitecturalSlot): boolean {
    return !valuesEqual(this.read(slot), this.inputValue(slot));
  }

  changedEntries(): readonly JitValueSlotEntry[] {
    return [...this.#values.values()].filter(({ slot }) => this.differsFromInput(slot));
  }
}

export class JitValueStateSnapshot {
  readonly slots: JitValueSlotSnapshot;
  readonly regs: JitRegisterValueSnapshotFamily;
  readonly flags: JitAluFlagValueSnapshotFamily;

  constructor(slots: JitValueSlotSnapshot) {
    this.slots = slots;
    this.regs = new JitRegisterValueSnapshotFamily(slots);
    this.flags = new JitAluFlagValueSnapshotFamily(slots);
  }
}

export class JitRegisterValueFamily {
  #slots: JitValueSlots;

  constructor(slots: JitValueSlots) {
    this.#slots = slots;
  }

  readReg32(reg: Reg32): JitValue {
    return this.#slots.read(reg32Slot(reg));
  }

  writeReg32(reg: Reg32, value: JitValue): void {
    this.#slots.write(reg32Slot(reg), value);
  }

  readReg16(reg: Reg16): JitValue {
    return this.#slots.read(reg16Slot(reg));
  }

  writeReg16(reg: Reg16, value: JitValue): void {
    this.#slots.write(reg16Slot(reg), value);
  }

  readReg8(reg: Reg8): JitValue {
    return this.#slots.read(reg8Slot(reg));
  }

  writeReg8(reg: Reg8, value: JitValue): void {
    this.#slots.write(reg8Slot(reg), value);
  }
}

export class JitRegisterValueSnapshotFamily {
  #slots: JitValueSlotSnapshot;

  constructor(slots: JitValueSlotSnapshot) {
    this.#slots = slots;
  }

  readReg32(reg: Reg32): JitValue {
    return this.#slots.read(reg32Slot(reg));
  }

  readReg16(reg: Reg16): JitValue {
    return this.#slots.read(reg16Slot(reg));
  }

  readReg8(reg: Reg8): JitValue {
    return this.#slots.read(reg8Slot(reg));
  }

  differsFromInput(reg: Reg32): boolean {
    return this.#slots.differsFromInput(reg32Slot(reg));
  }
}

export class JitAluFlagValueFamily {
  #slots: JitValueSlots;

  constructor(slots: JitValueSlots) {
    this.#slots = slots;
  }

  readAluFlags(): JitValue {
    return this.#slots.read(aluFlagsSlot());
  }

  writeAluFlags(value: JitValue): void {
    this.#slots.write(aluFlagsSlot(), value);
  }

  readFlagBits(mask: number): JitValue {
    assertIrAluFlagMask(mask, "JIT flag read mask");
    return jitExtractMaskedBits(this.readAluFlags(), mask);
  }

  writeFlagBits(mask: number, value: JitValue): void {
    assertIrAluFlagMask(mask, "JIT flag write mask");

    if (mask === IR_ALU_FLAG_MASK) {
      this.writeAluFlags(value);
      return;
    }

    this.writeAluFlags(jitInsertMaskedBits(this.readAluFlags(), value, mask));
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
    return this.#slots.read(aluFlagsSlot());
  }

  readFlagBits(mask: number): JitValue {
    assertIrAluFlagMask(mask, "JIT flag snapshot read mask");
    return jitExtractMaskedBits(this.readAluFlags(), mask);
  }

  condition(cc: ConditionCode): JitValue {
    return jitFlagConditionValue(this.readAluFlags(), cc);
  }

  differsFromInput(): boolean {
    return this.#slots.differsFromInput(aluFlagsSlot());
  }
}

export function createJitValueState(): JitValueState {
  return new JitValueState();
}

export function createJitValueStateFromSnapshot(snapshot: JitValueStateSnapshot): JitValueState {
  const state = createJitValueState();

  for (const { slot, value } of snapshot.slots.changedEntries()) {
    state.slots.write(slot, value);
  }

  return state;
}

export function reg32Slot(reg: Reg32): JitArchitecturalSlot {
  return { kind: "reg32", reg };
}

export function reg16Slot(reg: Reg16): JitArchitecturalSlot {
  return { kind: "reg16", reg };
}

export function reg8Slot(reg: Reg8): JitArchitecturalSlot {
  return { kind: "reg8", reg };
}

export function aluFlagsSlot(): JitArchitecturalSlot {
  return { kind: "aluFlags" };
}

function jitValueInputForSlot(slot: JitArchitecturalSlot): JitValue {
  switch (slot.kind) {
    case "reg32":
      return jitInputReg32Value(slot.reg);
    case "reg16":
    case "reg8":
      return jitInputForRegisterPart(slot);
    case "aluFlags":
      return jitInputAluFlagsValue();
  }
}

function jitInputForRegisterPart(slot: Extract<JitRegisterSlot, { kind: "reg16" | "reg8" }>): JitValue {
  const alias = jitRegisterSlotAlias(slot);

  return jitExtractBits(jitInputReg32Value(alias.base), alias.bitOffset, alias.width);
}

function jitValueSlotKey(slot: JitArchitecturalSlot): string {
  switch (slot.kind) {
    case "reg32":
      return `reg32:${slot.reg}`;
    case "reg16":
      return `reg16:${slot.reg}`;
    case "reg8":
      return `reg8:${slot.reg}`;
    case "aluFlags":
      return "aluFlags";
  }
}
