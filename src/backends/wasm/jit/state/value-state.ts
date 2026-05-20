import {
  JitAluFlagValueFamily,
  JitAluFlagValueSnapshotFamily
} from "./flag-values.js";
import {
  JitRegisterValueFamily,
  JitRegisterValueSnapshotFamily
} from "./register-values.js";
import {
  JitValueSlotSnapshot,
  JitValueSlots
} from "./value-slots.js";

export type { InputValues } from "./input-values.js";
export {
  aluFlagsSlot,
  JitAluFlagValueFamily,
  JitAluFlagValueSnapshotFamily
} from "./flag-values.js";
export {
  JitRegisterValueFamily,
  JitRegisterValueSnapshotFamily,
  reg16Slot,
  reg32Slot,
  reg8Slot
} from "./register-values.js";
export {
  JitValueSlotSnapshot,
  JitValueSlots,
  type JitValueSlotEntry,
  type JitValueSlotReader
} from "./value-slots.js";

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

export function createJitValueState(): JitValueState {
  return new JitValueState();
}

export function createJitValueStateFromSnapshot(snapshot: JitValueStateSnapshot): JitValueState {
  return new JitValueState(snapshot.slots.toMutableSlots());
}
