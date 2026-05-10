import { reg32, type OperandWidth, type Reg32 } from "#x86/isa/types.js";
import type { ConditionCode } from "#x86/ir/model/types.js";
import { IR_ALU_FLAG_MASK, assertIrAluFlagMask } from "#x86/ir/model/flag-effects.js";
import type { ExitMaterializationStore, MaterializationTarget } from "#backends/wasm/jit/ir/materialization.js";
import {
  jitExtractBits,
  jitExtractMaskedBits,
  jitFlagConditionValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  jitInsertMaskedBits,
  jitValuesEqual,
  simplifyJitValue,
  type JitArchitecturalSlot,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";

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
    return this.#values.get(jitValueSlotKey(slot))?.value ?? this.inputValue(slot);
  }

  write(slot: JitArchitecturalSlot, value: JitValue): void {
    this.#values.set(jitValueSlotKey(slot), { slot, value: simplifyJitValue(value) });
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
    return this.#values.get(jitValueSlotKey(slot))?.value ?? this.inputValue(slot);
  }

  inputValue(slot: JitArchitecturalSlot): JitValue {
    return jitValueInputForSlot(slot);
  }

  differsFromInput(slot: JitArchitecturalSlot): boolean {
    return !jitValuesEqual(this.read(slot), this.inputValue(slot));
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
  constructor(private readonly slots: JitValueSlots) {}

  readReg32(reg: Reg32): JitValue {
    return this.slots.read(reg32Slot(reg));
  }

  writeReg32(reg: Reg32, value: JitValue): void {
    this.slots.write(reg32Slot(reg), value);
  }

  readRegPart(reg: Reg32, bitOffset: number, width: OperandWidth): JitValue {
    return jitExtractBits(this.readReg32(reg), bitOffset, width);
  }

  writeRegPart(reg: Reg32, bitOffset: number, width: OperandWidth, value: JitValue): void {
    this.writeReg32(reg, jitInsertBits(this.readReg32(reg), value, bitOffset, width));
  }
}

export class JitRegisterValueSnapshotFamily {
  constructor(private readonly slots: JitValueSlotSnapshot) {}

  readReg32(reg: Reg32): JitValue {
    return this.slots.read(reg32Slot(reg));
  }

  readRegPart(reg: Reg32, bitOffset: number, width: OperandWidth): JitValue {
    return jitExtractBits(this.readReg32(reg), bitOffset, width);
  }

  differsFromInput(reg: Reg32): boolean {
    return this.slots.differsFromInput(reg32Slot(reg));
  }

  exitStores(regs: readonly Reg32[] = reg32): readonly ExitMaterializationStore[] {
    return regs.flatMap((reg) => {
      const store = this.exitStore(reg);

      return store === undefined ? [] : [store];
    });
  }

  exitStore(reg: Reg32): ExitMaterializationStore | undefined {
    const value = this.readReg32(reg);

    if (jitValuesEqual(value, this.slots.inputValue(reg32Slot(reg)))) {
      return undefined;
    }

    return narrowRegisterExitStore(reg, value) ?? {
      target: { kind: "reg32", reg },
      value
    };
  }
}

export class JitAluFlagValueFamily {
  constructor(private readonly slots: JitValueSlots) {}

  readAluFlags(): JitValue {
    return this.slots.read(aluFlagsSlot());
  }

  writeAluFlags(value: JitValue): void {
    this.slots.write(aluFlagsSlot(), value);
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
  constructor(private readonly slots: JitValueSlotSnapshot) {}

  readAluFlags(): JitValue {
    return this.slots.read(aluFlagsSlot());
  }

  readFlagBits(mask: number): JitValue {
    assertIrAluFlagMask(mask, "JIT flag snapshot read mask");
    return jitExtractMaskedBits(this.readAluFlags(), mask);
  }

  condition(cc: ConditionCode): JitValue {
    return jitFlagConditionValue(this.readAluFlags(), cc);
  }

  differsFromInput(): boolean {
    return this.slots.differsFromInput(aluFlagsSlot());
  }
}

export function createJitValueState(): JitValueState {
  return new JitValueState();
}

export function reg32Slot(reg: Reg32): JitArchitecturalSlot {
  return { kind: "reg32", reg };
}

export function aluFlagsSlot(): JitArchitecturalSlot {
  return { kind: "aluFlags" };
}

function jitValueInputForSlot(slot: JitArchitecturalSlot): JitValue {
  switch (slot.kind) {
    case "reg32":
      return jitInputReg32Value(slot.reg);
    case "aluFlags":
      return jitInputAluFlagsValue();
  }
}

function jitValueSlotKey(slot: JitArchitecturalSlot): string {
  switch (slot.kind) {
    case "reg32":
      return `reg32:${slot.reg}`;
    case "aluFlags":
      return "aluFlags";
  }
}

function narrowRegisterExitStore(reg: Reg32, value: JitValue): ExitMaterializationStore | undefined {
  const simplified = simplifyJitValue(value);

  if (simplified.kind !== "insertBits" || !isInputReg32(simplified.base, reg)) {
    return undefined;
  }

  const target = regPartTarget(reg, simplified.bitOffset, simplified.width);

  return target === undefined
    ? undefined
    : {
        target,
        value: simplified.value
      };
}

function regPartTarget(
  reg: Reg32,
  bitOffset: number,
  width: OperandWidth
): MaterializationTarget | undefined {
  if (!isLegalRegPart(bitOffset, width)) {
    return undefined;
  }

  return { kind: "regPart", reg, bitOffset, width };
}

function isLegalRegPart(bitOffset: number, width: OperandWidth): boolean {
  switch (width) {
    case 8:
      return bitOffset === 0 || bitOffset === 8;
    case 16:
      return bitOffset === 0;
    case 32:
      return false;
  }
}

function isInputReg32(value: JitValue, reg: Reg32): boolean {
  const simplified = simplifyJitValue(value);

  return simplified.kind === "input" && simplified.slot.kind === "reg32" && simplified.slot.reg === reg;
}
