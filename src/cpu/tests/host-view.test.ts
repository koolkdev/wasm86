import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { createCpuStateHostView } from "#cpu/host-view.js";
import {
  readWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf,
  writeWasmCpuStateSnapshot,
  type WasmCpuStateInit
} from "#test/support/cpu-state.js";
import { testExecutionModel } from "#test/support/execution-model.js";

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
// CPU/Wasm ABI bytes: kind=ADD (2), width=32 (2 << 2).
const add32LazyFlags = 0x0a;
const noLazyFlags = 0x00;

test("Cpu state host view rejects short memory", () => {
  throws(
    () => createStateHostView(new WebAssembly.Memory({ initial: 0 })),
    /execution-state memory is too small/
  );
});

test("Cpu state host view reads and writes architectural flags", () => {
  const { memory, state } = createState({ ...allFlagBytesSet });
  const { flags } = state;

  strictEqual(flags.readFlag("CF"), true);
  strictEqual(flags.readFlag("PF"), true);
  strictEqual(flags.readFlag("AF"), true);
  strictEqual(flags.readFlag("ZF"), true);
  strictEqual(flags.readFlag("SF"), true);
  strictEqual(flags.readFlag("OF"), true);
  strictEqual(flags.readFlag("TF"), true);
  strictEqual(flags.readFlag("DF"), true);
  strictEqual(flags.readFlag("NT"), true);
  strictEqual(flags.readFlag("AC"), true);
  strictEqual(flags.readFlag("ID"), true);
  deepStrictEqual(wasmCpuStatusFlagsOf(snapshot(memory)), allFlagsSet);

  flags.writeFlag("CF", false);
  flags.writeFlag("ID", false);

  strictEqual(flags.readFlag("CF"), false);
  strictEqual(flags.readFlag("ID"), false);

  seed(memory, {});
  deepStrictEqual(wasmCpuStatusFlagsOf(snapshot(memory)), noFlags);
});

test("Cpu state host view resolves lazy status flags without changing their owner state", () => {
  const { memory, state } = createState({
    CF: 0,
    PF: 0,
    AF: 0,
    ZF: 0,
    SF: 1,
    OF: 1,
    TF: 1,
    DF: 0,
    NT: 1,
    AC: 0,
    ID: 1,
    lazyFlagsKind: add32LazyFlags,
    lazyFlagsA: 0xffff_ffff,
    lazyFlagsB: 1
  });
  const before = snapshot(memory);

  strictEqual(state.flags.readFlag("CF"), true);
  strictEqual(state.flags.readFlag("PF"), true);
  strictEqual(state.flags.readFlag("AF"), true);
  strictEqual(state.flags.readFlag("ZF"), true);
  strictEqual(state.flags.readFlag("SF"), false);
  strictEqual(state.flags.readFlag("OF"), false);
  strictEqual(state.flags.readFlag("TF"), true);
  strictEqual(state.flags.readFlag("DF"), false);
  strictEqual(state.flags.readFlag("NT"), true);
  strictEqual(state.flags.readFlag("AC"), false);
  strictEqual(state.flags.readFlag("ID"), true);
  deepStrictEqual(snapshot(memory), before);
});

test("Cpu state host writes materialize lazy status flags before replacing one", () => {
  const backing = {
    CF: 0,
    PF: 0,
    AF: 0,
    ZF: 0,
    SF: 1,
    OF: 1
  } as const;
  const { memory, state } = createState({
    ...backing,
    DF: 0,
    lazyFlagsKind: add32LazyFlags,
    lazyFlagsA: 0xffff_ffff,
    lazyFlagsB: 1
  });

  state.flags.writeFlag("DF", true);
  deepStrictEqual(wasmCpuStatusFlagsOf(snapshot(memory)), backing);
  strictEqual(snapshot(memory).lazyFlagsKind, add32LazyFlags);

  state.flags.writeFlag("CF", false);

  strictEqual(state.flags.readFlag("CF"), false);
  strictEqual(state.flags.readFlag("PF"), true);
  strictEqual(state.flags.readFlag("AF"), true);
  strictEqual(state.flags.readFlag("ZF"), true);
  strictEqual(state.flags.readFlag("SF"), false);
  strictEqual(state.flags.readFlag("OF"), false);
  deepStrictEqual(wasmCpuStatusFlagsOf(snapshot(memory)), {
    CF: 0,
    PF: 1,
    AF: 1,
    ZF: 1,
    SF: 0,
    OF: 0
  });
  strictEqual(snapshot(memory).lazyFlagsKind, noLazyFlags);
  strictEqual(state.flags.readFlag("DF"), true);
});

test("Cpu state host view reads and writes general registers independently", () => {
  const { state } = createState({
    eax: 0xaabb_ccdd,
    ecx: 0x1122_3344,
    esi: 0x5566_7788
  });
  const { core } = state;

  strictEqual(core.readReg32("eax"), 0xaabb_ccdd);
  strictEqual(core.readReg32("ecx"), 0x1122_3344);
  strictEqual(core.readReg32("esi"), 0x5566_7788);

  core.writeReg32("eax", 0xdead_beef);

  strictEqual(core.readReg32("eax"), 0xdead_beef);
  strictEqual(core.readReg32("ecx"), 0x1122_3344);
  strictEqual(core.readReg32("esi"), 0x5566_7788);
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

  return { memory, state: createStateHostView(memory) };
}

function createStateHostView(memory: WebAssembly.Memory) {
  return createCpuStateHostView(
    createLayoutHostView(memory, testExecutionModel.cpuState.layout)
  );
}

function seed(memory: WebAssembly.Memory, initial: WasmCpuStateInit): void {
  writeWasmCpuStateSnapshot(new DataView(memory.buffer), initial);
}

function snapshot(memory: WebAssembly.Memory) {
  return readWasmCpuStateSnapshot(new DataView(memory.buffer));
}
