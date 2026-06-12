import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { reg32 } from "#x86/types.js";
import {
  cpuFlags,
  createCpuState,
  cloneCpuState,
  copyCpuState,
  cpuStatesEqual,
  getFlag,
  getReg32,
  hasEvenParityLowByte,
  setFlag,
  setReg32
} from "#x86/state/cpu-state.js";
import { u32 } from "#x86/numeric.js";

test("initial_state_zeroes_registers", () => {
  const state = createCpuState();

  for (const reg of reg32) {
    strictEqual(getReg32(state, reg), 0);
  }

  strictEqual(state.eip, 0);
  strictEqual(state.instructionCount, 0);
  strictEqual(state.stopReason, 0);

  for (const flag of cpuFlags) {
    strictEqual(getFlag(state, flag), false);
  }
});

test("register_roundtrip_all_gprs", () => {
  const state = createCpuState();

  for (const [index, reg] of reg32.entries()) {
    const value = 0x1_0000_0000 + index;
    setReg32(state, reg, value);

    strictEqual(getReg32(state, reg), u32(value));
  }
});

test("flag_roundtrip", () => {
  const state = createCpuState();

  for (const flag of cpuFlags) {
    setFlag(state, flag, true);
    strictEqual(getFlag(state, flag), true);

    for (const other of cpuFlags) {
      if (other !== flag) {
        strictEqual(getFlag(state, other), false);
      }
    }

    setFlag(state, flag, false);
    strictEqual(getFlag(state, flag), false);
  }
});

test("parity_low_byte", () => {
  for (const value of [0x00, 0x03, 0xff]) {
    strictEqual(hasEvenParityLowByte(value), true);
  }

  for (const value of [0x01, 0x07]) {
    strictEqual(hasEvenParityLowByte(value), false);
  }
});

test("modeled_flags_are_the_arithmetic_six", () => {
  deepStrictEqual(cpuFlags, ["CF", "PF", "AF", "ZF", "SF", "OF"]);
});

test("state_clone_copy_and_compare", () => {
  const source = createCpuState({
    eax: 0xffff_ffff,
    ecx: 0x1_0000_0001,
    eip: 0x1000,
    CF: 1,
    instructionCount: 7,
    stopReason: 3
  });
  const clone = cloneCpuState(source);
  const target = createCpuState();

  strictEqual(cpuStatesEqual(source, clone), true);

  clone.eax = 0;
  strictEqual(cpuStatesEqual(source, clone), false);

  copyCpuState(source, target);
  strictEqual(cpuStatesEqual(source, target), true);
});
