import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { createCpuStateHostView } from "#cpu/host-view.js";
import { createFlagStateHostView } from "#core/flags/host-view.js";
import { readRegisterAlias, writeRegisterAlias } from "#core/state/view.js";
import {
  x86Flags,
  x86StatusFlags,
  type X86StatusFlag
} from "#core/flags/definitions.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import { registerAlias } from "#core/registers.js";
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
type StatusFlagBytes = Readonly<Record<X86StatusFlag, 0 | 1>>;

test("Cpu state host view rejects short memory", () => {
  throws(
    () => createStateHostView(new WebAssembly.Memory({ initial: 0 })),
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

test("Cpu state host view resolves lazy status flags without changing their owner state", () => {
  const cases = [
    {
      name: "ADD8 carry",
      kind: LAZY_FLAGS_KIND.ADD,
      width: 8,
      a: 0xf0,
      b: 0x70,
      expected: { CF: 1, PF: 1, AF: 0, ZF: 0, SF: 0, OF: 0 }
    },
    {
      name: "ADD16 signed overflow",
      kind: LAZY_FLAGS_KIND.ADD,
      width: 16,
      a: 0x7fff,
      b: 1,
      expected: { CF: 0, PF: 1, AF: 1, ZF: 0, SF: 1, OF: 1 }
    },
    {
      name: "ADD32 wraparound",
      kind: LAZY_FLAGS_KIND.ADD,
      width: 32,
      a: 0xffff_ffff,
      b: 1,
      expected: { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 0, OF: 0 }
    },
    {
      name: "SUB8 borrow",
      kind: LAZY_FLAGS_KIND.SUB,
      width: 8,
      a: 0,
      b: 1,
      expected: { CF: 1, PF: 1, AF: 1, ZF: 0, SF: 1, OF: 0 }
    },
    {
      name: "SUB16 signed overflow",
      kind: LAZY_FLAGS_KIND.SUB,
      width: 16,
      a: 0x8000,
      b: 1,
      expected: { CF: 0, PF: 1, AF: 1, ZF: 0, SF: 0, OF: 1 }
    },
    {
      name: "SUB32 zero",
      kind: LAZY_FLAGS_KIND.SUB,
      width: 32,
      a: 5,
      b: 5,
      expected: { CF: 0, PF: 1, AF: 0, ZF: 1, SF: 0, OF: 0 }
    },
    {
      name: "LOGIC_RESULT8 odd parity",
      kind: LAZY_FLAGS_KIND.LOGIC_RESULT,
      width: 8,
      a: 1,
      b: 0xaaaa_aaaa,
      expected: { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 }
    },
    {
      name: "LOGIC_RESULT16 sign",
      kind: LAZY_FLAGS_KIND.LOGIC_RESULT,
      width: 16,
      a: 0x8000,
      b: 0xaaaa_aaaa,
      expected: { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 1, OF: 0 }
    },
    {
      name: "LOGIC_RESULT32 zero",
      kind: LAZY_FLAGS_KIND.LOGIC_RESULT,
      width: 32,
      a: 0,
      b: 0xaaaa_aaaa,
      expected: { CF: 0, PF: 1, AF: 0, ZF: 1, SF: 0, OF: 0 }
    }
  ] as const satisfies readonly Readonly<{
    name: string;
    kind: Exclude<(typeof LAZY_FLAGS_KIND)[keyof typeof LAZY_FLAGS_KIND], 0>;
    width: 8 | 16 | 32;
    a: number;
    b: number;
    expected: StatusFlagBytes;
  }>[];

  for (const entry of cases) {
    const backing = oppositeStatusFlags(entry.expected);
    const { memory, state } = createState({
      ...backing,
      TF: 1,
      DF: 0,
      NT: 1,
      AC: 0,
      ID: 1,
      lazyFlagsKind: lazyFlagsKindByte(entry.kind, entry.width),
      lazyFlagsA: entry.a,
      lazyFlagsB: entry.b
    });
    const directFlags = createFlagStateHostView(
      createLayoutHostView(memory, testExecutionModel.cpuState.layout)
    );
    const before = snapshot(memory);

    for (const flag of x86StatusFlags) {
      strictEqual(directFlags.readFlagByte(flag), entry.expected[flag], `${entry.name} ${flag} byte`);
      strictEqual(state.flags.readFlag(flag), entry.expected[flag] !== 0, `${entry.name} ${flag}`);
    }
    strictEqual(state.flags.readFlag("TF"), true, `${entry.name} TF`);
    strictEqual(state.flags.readFlag("DF"), false, `${entry.name} DF`);
    strictEqual(state.flags.readFlag("NT"), true, `${entry.name} NT`);
    strictEqual(state.flags.readFlag("AC"), false, `${entry.name} AC`);
    strictEqual(state.flags.readFlag("ID"), true, `${entry.name} ID`);
    deepStrictEqual(snapshot(memory), before, `${entry.name} read mutated owner state`);
  }
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
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.ADD, 32),
    lazyFlagsA: 0xffff_ffff,
    lazyFlagsB: 1
  });

  state.flags.writeFlag("DF", true);
  deepStrictEqual(wasmCpuStatusFlagsOf(snapshot(memory)), backing);
  strictEqual(snapshot(memory).lazyFlagsKind, lazyFlagsKindByte(LAZY_FLAGS_KIND.ADD, 32));

  state.flags.writeFlag("CF", false);

  deepStrictEqual(
    x86StatusFlags.map((flag) => [flag, state.flags.readFlag(flag)]),
    [
      ["CF", false],
      ["PF", true],
      ["AF", true],
      ["ZF", true],
      ["SF", false],
      ["OF", false]
    ]
  );
  deepStrictEqual(wasmCpuStatusFlagsOf(snapshot(memory)), {
    CF: 0,
    PF: 1,
    AF: 1,
    ZF: 1,
    SF: 0,
    OF: 0
  });
  strictEqual(snapshot(memory).lazyFlagsKind, LAZY_FLAGS_KIND.NONE);
  strictEqual(snapshot(memory).lazyFlagsA, 0xffff_ffff);
  strictEqual(snapshot(memory).lazyFlagsB, 1);
  strictEqual(state.flags.readFlag("DF"), true);
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

function oppositeStatusFlags(flags: StatusFlagBytes): StatusFlagBytes {
  return {
    CF: flags.CF === 0 ? 1 : 0,
    PF: flags.PF === 0 ? 1 : 0,
    AF: flags.AF === 0 ? 1 : 0,
    ZF: flags.ZF === 0 ? 1 : 0,
    SF: flags.SF === 0 ? 1 : 0,
    OF: flags.OF === 0 ? 1 : 0
  };
}
