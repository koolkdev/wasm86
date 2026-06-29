import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { readRegisterAlias, writeRegisterAlias } from "#x86/cpu-state.js";
import { lazyFlagsKindByte } from "#ir/lazy-flags.js";
import { x86Flags } from "#x86/flags.js";
import { registerAlias } from "#x86/registers.js";
import { readWasmCpuState, wasmCpuStatusFlagsOf } from "#runtime/tests/fixtures/cpu-state.js";
import { WASM_CPU_LAZY_FLAGS_KIND } from "#wasm/cpu-state-layout.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;
const allFlagBytesSet = {
  CF: 1,
  PF: 1,
  AF: 1,
  ZF: 1,
  SF: 1,
  OF: 1,
  DF: 1,
  TF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;
const noFlags = { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;

test("host view initializes lazy flag metadata to none", () => {
  const { cpuState: state } = createWasmHostMemories();

  state.load({});

  const snapshot = readWasmCpuState(state);

  strictEqual(snapshot.lazyFlagsKind, lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.NONE, 0));
  strictEqual(snapshot.lazyFlagsA, 0);
  strictEqual(snapshot.lazyFlagsB, 0);
});

test("host view stores lazy flag kind byte fields as bytes, not bits", () => {
  const { cpuState: state } = createWasmHostMemories();
  const kindByte = lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.LOGIC_RESULT, 32);

  state.load({ lazyFlagsKind: kindByte });

  const snapshot = readWasmCpuState(state);

  strictEqual(snapshot.lazyFlagsKind, kindByte);
});

test("host view stores flag fields as flag bytes and reads them back", () => {
  const { cpuState: state } = createWasmHostMemories();

  state.load({ ...allFlagBytesSet });

  deepStrictEqual(
    x86Flags.map((flag) => [flag, state.readFlag(flag)]),
    [
      ["CF", true],
      ["PF", true],
      ["AF", true],
      ["ZF", true],
      ["SF", true],
      ["OF", true],
      ["TF", true],
      ["DF", true],
      ["NT", true],
      ["AC", true],
      ["ID", true]
    ]
  );
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuState(state)), allFlagsSet);

  state.load({});

  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuState(state)), noFlags);
  deepStrictEqual(
    x86Flags.map((flag) => state.readFlag(flag)),
    [false, false, false, false, false, false, false, false, false, false, false]
  );
});

test("flag writes are visible to snapshots", () => {
  const { cpuState: state } = createWasmHostMemories();

  state.load({ CF: 1, ZF: 0xff });

  strictEqual(state.readFlag("CF"), true);
  strictEqual(state.readFlag("ZF"), true);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuState(state)), { ...noFlags, CF: 1, ZF: 1 });

  state.writeFlag("CF", false);
  state.writeFlag("ID", true);

  strictEqual(state.readFlag("CF"), false);
  strictEqual(state.readFlag("ID"), true);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuState(state)), { ...noFlags, ZF: 1 });
});

test("host view stores register words and supports x86 register aliases", () => {
  const { cpuState: state } = createWasmHostMemories();

  state.load({ eax: 0xaabb_ccdd, ecx: 0x1122_3344, esi: 0x5566_7788 });

  strictEqual(state.readReg32("eax"), 0xaabb_ccdd);
  strictEqual(readRegisterAlias(state, registerAlias("ax")), 0xccdd);
  strictEqual(readRegisterAlias(state, registerAlias("al")), 0xdd);
  strictEqual(readRegisterAlias(state, registerAlias("ah")), 0xcc);
  strictEqual(readRegisterAlias(state, registerAlias("si")), 0x7788);

  writeRegisterAlias(state, registerAlias("ah"), 0x11);

  strictEqual(state.readReg32("eax"), 0xaabb_11dd);

  writeRegisterAlias(state, registerAlias("al"), 0x22);

  strictEqual(state.readReg32("eax"), 0xaabb_1122);

  writeRegisterAlias(state, registerAlias("ax"), 0x3344);

  strictEqual(state.readReg32("eax"), 0xaabb_3344);

  state.writeReg32("eax", 0xdead_beef);

  strictEqual(state.readReg32("eax"), 0xdead_beef);
  strictEqual(state.readReg32("ecx"), 0x1122_3344);

  writeRegisterAlias(state, registerAlias("cl"), 0x99);

  strictEqual(state.readReg32("ecx"), 0x1122_3399);
  strictEqual(state.readReg32("esi"), 0x5566_7788);
});

test("narrow register alias writes truncate the value and leave neighbor bytes untouched", () => {
  const { cpuState: state } = createWasmHostMemories();

  state.load({ eax: 0xdead_beef });

  writeRegisterAlias(state, registerAlias("al"), 0x1ff);

  strictEqual(state.readReg32("eax"), 0xdead_beff);

  writeRegisterAlias(state, registerAlias("ah"), 0x301);

  strictEqual(state.readReg32("eax"), 0xdead_01ff);

  writeRegisterAlias(state, registerAlias("ax"), 0x5_4321);

  strictEqual(state.readReg32("eax"), 0xdead_4321);
});

test("host view stores segment selectors separately from segment bases", () => {
  const { cpuState: state } = createWasmHostMemories();

  state.load({ fsSelector: 0x12345, fsBase: 0xaabb_ccdd, gsSelector: 0x33 });

  strictEqual(state.readSegmentSelector("fs"), 0x2345);
  strictEqual(state.readSegmentBase("fs"), 0xaabb_ccdd);
  strictEqual(state.readSegmentSelector("gs"), 0x33);
  strictEqual(state.readSegmentBase("gs"), 0);

  state.writeSegmentSelector("fs", 0x1_0044);
  state.writeSegmentBase("fs", 0xffff_0000);

  strictEqual(state.readSegmentSelector("fs"), 0x44);
  strictEqual(state.readSegmentBase("fs"), 0xffff_0000);
});
