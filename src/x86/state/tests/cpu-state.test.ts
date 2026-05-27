import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { reg32 } from "#x86/types.js";
import {
  arithmeticEflagsMask,
  controlEflagsMask,
  cpuArithmeticFlags,
  cpuControlFlags,
  cpuFlags,
  createCpuState,
  cloneCpuState,
  copyCpuState,
  cpuStatesEqual,
  eflagsFieldMask,
  eflagsMask,
  getFlag,
  getReg32,
  hasEvenParityLowByte,
  setFlag,
  setReg32,
  supportedEflagsMask
} from "#x86/state/cpu-state.js";
import { u32 } from "#x86/numeric.js";

test("initial_state_zeroes_registers", () => {
  const state = createCpuState();

  for (const reg of reg32) {
    strictEqual(getReg32(state, reg), 0);
  }

  strictEqual(state.eip, 0);
  strictEqual(state.eflags, 0);
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

test("flag_roundtrip_supported_subset", () => {
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

test("unsupported_eflags_bits_preserved", () => {
  const unsupportedBits = u32(0xffff_ffff & ~supportedEflagsMask);
  const state = createCpuState({ eflags: unsupportedBits });

  for (const flag of cpuFlags) {
    setFlag(state, flag, true);
    strictEqual(u32(state.eflags & ~supportedEflagsMask), unsupportedBits);

    setFlag(state, flag, false);
    strictEqual(u32(state.eflags & ~supportedEflagsMask), unsupportedBits);
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

test("eflags_masks_match_x86_layout", () => {
  deepStrictEqual(eflagsMask, {
    CF: 1 << 0,
    PF: 1 << 2,
    AF: 1 << 4,
    ZF: 1 << 6,
    SF: 1 << 7,
    TF: 1 << 8,
    IF: 1 << 9,
    DF: 1 << 10,
    OF: 1 << 11,
    NT: 1 << 14,
    RF: 1 << 16,
    VM: 1 << 17,
    AC: 1 << 18,
    ID: 1 << 21
  });
  deepStrictEqual(eflagsFieldMask, {
    IOPL: 0b11 << 12
  });
  deepStrictEqual(cpuArithmeticFlags, ["CF", "PF", "AF", "ZF", "SF", "OF"]);
  deepStrictEqual(cpuControlFlags, ["TF", "IF", "DF", "NT", "RF", "VM", "AC", "ID"]);
  strictEqual(
    arithmeticEflagsMask,
    eflagsMask.CF |
      eflagsMask.PF |
      eflagsMask.AF |
      eflagsMask.ZF |
      eflagsMask.SF |
      eflagsMask.OF
  );
  strictEqual(
    controlEflagsMask,
    eflagsMask.TF |
      eflagsMask.IF |
      eflagsMask.DF |
      eflagsFieldMask.IOPL |
      eflagsMask.NT |
      eflagsMask.RF |
      eflagsMask.VM |
      eflagsMask.AC |
      eflagsMask.ID
  );
  strictEqual(supportedEflagsMask, (arithmeticEflagsMask | controlEflagsMask) >>> 0);
});

test("state_clone_copy_and_compare", () => {
  const source = createCpuState({
    eax: 0xffff_ffff,
    ecx: 0x1_0000_0001,
    eip: 0x1000,
    eflags: eflagsMask.CF,
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
