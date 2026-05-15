import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { IR_ALU_FLAG_MASK, IR_ALU_FLAG_MASKS } from "#x86/ir/model/flag-effects.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import type { Reg32 } from "#x86/isa/types.js";
import {
  jitExtractBits,
  jitExtractMaskedBits,
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  jitInsertMaskedBits
} from "#backends/wasm/jit/ir/values/builders.js";
import type {
  JitArchitecturalSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import {
  createJitValueState,
  type JitValueSlotEntry
} from "#backends/wasm/jit/state/value-state.js";

export {
  deepStrictEqual,
  strictEqual,
  test,
  IR_ALU_FLAG_MASK,
  IR_ALU_FLAG_MASKS,
  FLAG_PRODUCERS,
  jitExtractBits,
  jitExtractMaskedBits,
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  jitInsertMaskedBits,
  createJitValueState
};
export type { Reg32, JitArchitecturalSlot, JitValue, JitValueSlotEntry };

export function xchg(
  state: ReturnType<typeof createJitValueState>,
  left: Reg32,
  right: Reg32
): void {
  const leftValue = state.regs.readReg32(left);
  const rightValue = state.regs.readReg32(right);

  state.regs.writeReg32(left, rightValue);
  state.regs.writeReg32(right, leftValue);
}

export function c32(value: number): JitValue {
  return { kind: "const", type: "i32", value };
}

export function add(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}

export function changedSlots(entries: readonly JitValueSlotEntry[]): readonly string[] {
  return entries.map(({ slot }) => slotKey(slot)).sort();
}

export function slotKey(slot: JitArchitecturalSlot): string {
  switch (slot.kind) {
    case "reg32":
      return `reg32:${slot.reg}`;
    case "aluFlags":
      return "aluFlags";
  }
}
