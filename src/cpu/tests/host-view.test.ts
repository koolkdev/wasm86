import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createCpuStateHostView } from "#cpu/host-view.js";
import { readRegisterAlias, writeRegisterAlias } from "#core/state/view.js";
import { x86Flags } from "#core/flags/definitions.js";
import { registerAlias } from "#core/registers.js";
import {
  readWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf,
  writeWasmCpuStateSnapshot,
  type WasmCpuStateInit
} from "#test/support/cpu-state.js";

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

test("Cpu state host view rejects short memory", () => {
  throws(
    () => createCpuStateHostView(new WebAssembly.Memory({ initial: 0 })),
    /execution-state memory is too small/
  );
});

test("Cpu state host view reads and writes architectural flags", () => {
  const { memory, state } = createState({ ...allFlagBytesSet });
  const { flags } = state;

  deepStrictEqual(
    x86Flags.map((flag) => [flag, flags.readFlag(flag)]),
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
  deepStrictEqual(wasmCpuStatusFlagsOf(snapshot(memory)), allFlagsSet);

  flags.writeFlag("CF", false);
  flags.writeFlag("ID", false);

  strictEqual(flags.readFlag("CF"), false);
  strictEqual(flags.readFlag("ID"), false);

  seed(memory, {});
  deepStrictEqual(wasmCpuStatusFlagsOf(snapshot(memory)), noFlags);
});

test("Cpu state host view supports full and aliased registers", () => {
  const { state } = createState({
    eax: 0xaabb_ccdd,
    ecx: 0x1122_3344,
    esi: 0x5566_7788
  });
  const { core } = state;

  strictEqual(core.readReg32("eax"), 0xaabb_ccdd);
  strictEqual(readRegisterAlias(core, registerAlias("ax")), 0xccdd);
  strictEqual(readRegisterAlias(core, registerAlias("al")), 0xdd);
  strictEqual(readRegisterAlias(core, registerAlias("ah")), 0xcc);
  strictEqual(readRegisterAlias(core, registerAlias("si")), 0x7788);

  writeRegisterAlias(core, registerAlias("ah"), 0x11);
  writeRegisterAlias(core, registerAlias("al"), 0x22);
  writeRegisterAlias(core, registerAlias("ax"), 0x3344);

  strictEqual(core.readReg32("eax"), 0xaabb_3344);

  core.writeReg32("eax", 0xdead_beef);
  writeRegisterAlias(core, registerAlias("cl"), 0x99);

  strictEqual(core.readReg32("eax"), 0xdead_beef);
  strictEqual(core.readReg32("ecx"), 0x1122_3399);
  strictEqual(core.readReg32("esi"), 0x5566_7788);
});

test("narrow register writes truncate without changing neighboring bytes", () => {
  const { state } = createState({ eax: 0xdead_beef });
  const { core } = state;

  writeRegisterAlias(core, registerAlias("al"), 0x1ff);
  strictEqual(core.readReg32("eax"), 0xdead_beff);

  writeRegisterAlias(core, registerAlias("ah"), 0x301);
  strictEqual(core.readReg32("eax"), 0xdead_01ff);

  writeRegisterAlias(core, registerAlias("ax"), 0x5_4321);
  strictEqual(core.readReg32("eax"), 0xdead_4321);
});

test("Cpu state host view keeps segment fields independent", () => {
  const { memory, state } = createState({
    fsSelector: 0x12345,
    fsBase: 0xaabb_ccdd,
    fsLimit: 0xffff_ffff,
    fsAccess: 0x0000_00e0,
    gsSelector: 0x3
  });
  const { core } = state;

  strictEqual(core.readSegmentSelector("fs"), 0x2345);
  strictEqual(core.readSegmentBase("fs"), 0xaabb_ccdd);
  strictEqual(core.readSegmentLimit("fs"), 0xffff_ffff);
  strictEqual(core.readSegmentAccess("fs"), 0x0000_00e0);
  strictEqual(core.readSegmentSelector("gs"), 0x3);
  strictEqual(core.readSegmentBase("gs"), 0);
  strictEqual(core.readSegmentLimit("gs"), 0);
  strictEqual(core.readSegmentAccess("gs"), 0);
  strictEqual(snapshot(memory).fsLimit, 0xffff_ffff);
  strictEqual(snapshot(memory).fsAccess, 0x0000_00e0);

  core.writeSegmentSelector("fs", 0x1_0044);
  core.writeSegmentBase("fs", 0xffff_0000);
  core.writeSegmentLimit("fs", 0);
  core.writeSegmentAccess("fs", 0x1_0000_00a0);

  strictEqual(core.readSegmentSelector("fs"), 0x44);
  strictEqual(core.readSegmentBase("fs"), 0xffff_0000);
  strictEqual(core.readSegmentLimit("fs"), 0);
  strictEqual(core.readSegmentAccess("fs"), 0x0000_00a0);
});

test("Cpu state host view exposes the persistent instruction count", () => {
  const { state } = createState({ instructionCount: 17 });

  strictEqual(state.instructionCount, 17);
});

function createState(initial: WasmCpuStateInit): Readonly<{
  memory: WebAssembly.Memory;
  state: ReturnType<typeof createCpuStateHostView>;
}> {
  const memory = new WebAssembly.Memory({ initial: 1 });
  seed(memory, initial);

  return { memory, state: createCpuStateHostView(memory) };
}

function seed(memory: WebAssembly.Memory, initial: WasmCpuStateInit): void {
  writeWasmCpuStateSnapshot(new DataView(memory.buffer), initial);
}

function snapshot(memory: WebAssembly.Memory) {
  return readWasmCpuStateSnapshot(new DataView(memory.buffer));
}
