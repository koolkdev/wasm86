import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createInstructionBudget } from "#runtime/execution/budget.js";
import { RuntimeMode } from "#runtime/execution/mode.js";
import { runRuntimeProgram, type RuntimeEngines } from "#runtime/execution/runner.js";
import {
  assertEngineFixtureResult,
  createFixtureCompiledOnlyEngines,
  createFixtureInterpreterOnlyEngines,
  prepareEngineFixture
} from "#runtime/tests/fixtures/helpers.js";
import { engineFixtureStartAddress } from "#runtime/tests/fixtures/programs.js";
import type { EngineFixture, MemoryPatch } from "#runtime/tests/fixtures/types.js";
import type { WasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import type { WasmHostMemories } from "#wasm/host/memories.js";
import { aluReference } from "#wasm/emit/tests/reference.js";
import type { OperandWidth } from "#x86/types.js";

const trap = [0xcd, 0x2e] as const;
const guestByteLength = 0x10000;
const allStatusFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;
const sourceAddress = 0x20;
const destOffset = 0x30;
const esBase = 0;

const modes = [
  {
    name: "interpreter",
    mode: RuntimeMode.INTERPRETER,
    engines: createFixtureInterpreterOnlyEngines
  },
  {
    name: "compiled-blocks",
    mode: RuntimeMode.COMPILED_BLOCKS,
    engines: createFixtureCompiledOnlyEngines
  }
] as const satisfies readonly {
  name: string;
  mode: RuntimeMode;
  engines(memories: WasmHostMemories): RuntimeEngines;
}[];

for (const width of [8, 16, 32] as const) {
  for (const df of [0, 1] as const) {
    runFixture(movsFixture(width, df));
    runFixture(stosFixture(width, df));
    runFixture(lodsFixture(width, df));
    runFixture(cmpsFixture(width, df));
    runFixture(scasFixture(width, df));
  }
}

runFixture({
  name: "movs-source-segment-override-uses-fs-destination-stays-es/trap",
  bytes: withTrap([0x64, 0xa4]),
  initialState: {
    esi: sourceAddress,
    edi: destOffset,
    fsBase: 0x1000,
    esBase,
    eip: engineFixtureStartAddress
  },
  initialMemory: [
    { address: sourceAddress, bytes: [0x11] },
    { address: 0x1000 + sourceAddress, bytes: [0x7c] }
  ],
  expected: {
    result: { stop: { kind: "hostTrap", vector: 0x2e } },
    state: {
      esi: sourceAddress + 1,
      edi: destOffset + 1,
      fsBase: 0x1000,
      esBase,
      eip: engineFixtureStartAddress + 4,
      instructionCount: 2
    },
    memory: [{ address: esBase + destOffset, bytes: [0x7c] }]
  }
});

for (const runMode of modes) {
  test(`${runMode.name} executes stos with inert GS override and fixed ES destination`, () => {
    const fixture: EngineFixture = {
      name: "stos-gs-override-stays-es/trap",
      bytes: withTrap([0x65, 0xaa]),
      initialState: {
        eax: 0x5a,
        edi: destOffset,
        esBase,
        gsBase: 0x3000,
        eip: engineFixtureStartAddress
      },
      expected: {
        result: { stop: { kind: "hostTrap", vector: 0x2e } },
        state: {
          eax: 0x5a,
          edi: destOffset + 1,
          esBase,
          gsBase: 0x3000,
          eip: engineFixtureStartAddress + 4,
          instructionCount: 2
        },
        memory: [{ address: esBase + destOffset, bytes: [0x5a] }]
      }
    };
    const { codeMap, memories } = prepareEngineFixture(fixture);
    const result = runRuntimeProgram(
      runMode.mode,
      { codeMap, memories },
      createInstructionBudget(0, 100),
      runMode.engines(memories)
    );

    assertEngineFixtureResult(fixture, result, memories);
    const gsByte = memories.guest.readU8(0x3000 + destOffset);

    strictEqual(gsByte.ok, true);
    if (gsByte.ok) {
      strictEqual(gsByte.value, 0);
    }
  });
}

runFixture({
  name: "movs-write-guard-fault-leaves-pointers-and-flags-uncommitted",
  bytes: movsOpcode(32),
  initialState: {
    esi: sourceAddress,
    edi: guestByteLength - 2,
    ...allStatusFlagsSet,
    eip: engineFixtureStartAddress
  },
  initialMemory: [
    { address: sourceAddress, bytes: dwordBytes(0xfeed_cafe) }
  ],
  expected: {
    result: {
      stop: {
        kind: "cpuException",
        exception: { kind: "PF", linearAddress: guestByteLength - 2, errorCode: 2 }
      }
    },
    state: {
      esi: sourceAddress,
      edi: guestByteLength - 2,
      ...allStatusFlagsSet,
      eip: engineFixtureStartAddress,
      instructionCount: 0
    }
  }
});

runFixture(repMovsdFixture(0));
runFixture(repMovsdFixture(1));
runFixture(repMovsPrefixSequenceFixture("rep-movsw-f3-66-prefix-order/trap", [0xf3, 0x66, 0xa5], 16));
runFixture(repMovsPrefixSequenceFixture("rep-movsw-66-f3-prefix-order/trap", [0x66, 0xf3, 0xa5], 16));
runFixture(repMovsPrefixSequenceFixture("rep-movsd-f2-f3-last-wins/trap", [0xf2, 0xf3, 0xa5], 32));

runFixture({
  name: "rep-movsd-zero-count-skips-memory-and-preserves-flags/trap",
  bytes: withTrap(repMovsOpcode(32)),
  initialState: {
    ecx: 0,
    esi: sourceAddress,
    edi: destOffset,
    esBase,
    ...allStatusFlagsSet,
    eip: engineFixtureStartAddress
  },
  initialMemory: [
    { address: sourceAddress, bytes: dwordBytes(0xfeed_cafe) },
    { address: esBase + destOffset, bytes: dwordBytes(0x1122_3344) }
  ],
  expected: {
    result: { stop: { kind: "hostTrap", vector: 0x2e } },
    state: {
      ecx: 0,
      esi: sourceAddress,
      edi: destOffset,
      esBase,
      ...allStatusFlagsSet,
      eip: engineFixtureStartAddress + repMovsOpcode(32).length + trap.length,
      instructionCount: 2
    },
    memory: [{ address: esBase + destOffset, bytes: dwordBytes(0x1122_3344) }]
  }
});

runFixture({
  name: "repe-cmpsb-stops-at-first-mismatch/trap",
  bytes: withTrap([...repeCmpsOpcode(8), 0x9f, 0x0f, 0x90, 0xc3]),
  initialState: {
    eax: 0x1122_3300,
    ebx: 0x1234_5600,
    ecx: 4,
    esi: sourceAddress,
    edi: destOffset,
    esBase,
    eip: engineFixtureStartAddress
  },
  initialMemory: [
    { address: sourceAddress, bytes: [1, 2, 3, 4] },
    { address: esBase + destOffset, bytes: [1, 2, 9, 4] }
  ],
  expected: {
    result: { stop: { kind: "hostTrap", vector: 0x2e } },
    state: {
      eax: ((0x1122_3300 & 0xffff_00ff) | (lahfImage(aluReference("cmp", 8, 3, 9).flags) << 8)) >>> 0,
      ebx: 0x1234_5600 | aluReference("cmp", 8, 3, 9).flags.OF,
      ecx: 1,
      esi: sourceAddress + 3,
      edi: destOffset + 3,
      esBase,
      eip: engineFixtureStartAddress + repeCmpsOpcode(8).length + 1 + 3 + trap.length,
      instructionCount: 6
    }
  }
});

runFixture({
  name: "repne-scasb-finds-matching-byte/trap",
  bytes: withTrap(repneScasOpcode(8)),
  initialState: {
    eax: accumulatorInitial(8, 3),
    ecx: 4,
    edi: destOffset,
    esBase,
    eip: engineFixtureStartAddress
  },
  initialMemory: [
    { address: esBase + destOffset, bytes: [1, 2, 3, 4] }
  ],
  expected: {
    result: { stop: { kind: "hostTrap", vector: 0x2e } },
    state: {
      eax: accumulatorInitial(8, 3),
      ecx: 1,
      edi: destOffset + 3,
      esBase,
      eip: engineFixtureStartAddress + repneScasOpcode(8).length + trap.length,
      instructionCount: 4
    }
  }
});

runFixture({
  name: "rep-movsd-write-guard-fault-commits-prior-iteration",
  bytes: repMovsOpcode(32),
  initialState: {
    ecx: 2,
    esi: sourceAddress,
    edi: guestByteLength - 4,
    esBase,
    eip: engineFixtureStartAddress
  },
  initialMemory: [
    { address: sourceAddress, bytes: [...dwordBytes(0x1111_2222), ...dwordBytes(0x3333_4444)] }
  ],
  expected: {
    result: {
      stop: {
        kind: "cpuException",
        exception: { kind: "PF", linearAddress: guestByteLength, errorCode: 2 }
      }
    },
    state: {
      ecx: 1,
      esi: sourceAddress + 4,
      edi: guestByteLength,
      esBase,
      eip: engineFixtureStartAddress,
      instructionCount: 1
    },
    memory: [{ address: guestByteLength - 4, bytes: dwordBytes(0x1111_2222) }]
  }
});

function runFixture(fixture: EngineFixture): void {
  for (const runMode of modes) {
    test(`${runMode.name} executes ${fixture.name}`, () => {
      const { codeMap, memories } = prepareEngineFixture(fixture);
      const result = runRuntimeProgram(
        runMode.mode,
        { codeMap, memories },
        createInstructionBudget(0, 100),
        runMode.engines(memories)
      );

      assertEngineFixtureResult(fixture, result, memories);
    });
  }
}

function repMovsdFixture(df: 0 | 1): EngineFixture {
  const values = [0x1111_2222, 0x3333_4444, 0x5555_6666];
  const bytes = values.flatMap((value) => [...dwordBytes(value)]);
  const startOffset = df === 0 ? 0 : 8;
  const finalOffset = df === 0 ? 12 : -4;

  return {
    name: `rep-movsd-df${df}/trap`,
    bytes: withTrap(repMovsOpcode(32)),
    initialState: {
      ecx: 3,
      esi: sourceAddress + startOffset,
      edi: destOffset + startOffset,
      esBase,
      DF: df,
      eip: engineFixtureStartAddress
    },
    initialMemory: [
      { address: sourceAddress, bytes }
    ],
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        ecx: 0,
        esi: sourceAddress + finalOffset,
        edi: destOffset + finalOffset,
        esBase,
        DF: df,
        eip: engineFixtureStartAddress + repMovsOpcode(32).length + trap.length,
        instructionCount: 4
      },
      memory: [{ address: esBase + destOffset, bytes }]
    }
  };
}

function repMovsPrefixSequenceFixture(
  name: string,
  opcode: readonly number[],
  width: 16 | 32
): EngineFixture {
  const values = width === 16
    ? [0x1122, 0x3344, 0x5566]
    : [0x1111_2222, 0x3333_4444];
  const bytes = values.flatMap((value) => [...bytesForWidth(width, value)]);
  const byteLength = bytes.length;

  return {
    name,
    bytes: withTrap(opcode),
    initialState: {
      ecx: values.length,
      esi: sourceAddress,
      edi: destOffset,
      esBase,
      ...allStatusFlagsSet,
      eip: engineFixtureStartAddress
    },
    initialMemory: [
      { address: sourceAddress, bytes }
    ],
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        ecx: 0,
        esi: sourceAddress + byteLength,
        edi: destOffset + byteLength,
        esBase,
        ...allStatusFlagsSet,
        eip: engineFixtureStartAddress + opcode.length + trap.length,
        instructionCount: values.length + 1
      },
      memory: [{ address: esBase + destOffset, bytes }]
    }
  };
}

function movsFixture(width: OperandWidth, df: 0 | 1): EngineFixture {
  const value = valueForWidth(width);
  const step = stepFor(width, df);

  return {
    name: `movs-${width}-df${df}/trap`,
    bytes: withTrap(movsOpcode(width)),
    initialState: {
      esi: sourceAddress,
      edi: destOffset,
      esBase,
      DF: df,
      ...allStatusFlagsSet,
      eip: engineFixtureStartAddress
    },
    initialMemory: [
      { address: sourceAddress, bytes: bytesForWidth(width, value) }
    ],
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        esi: u32(sourceAddress + step),
        edi: u32(destOffset + step),
        esBase,
        DF: df,
        ...allStatusFlagsSet,
        eip: engineFixtureStartAddress + movsOpcode(width).length + trap.length,
        instructionCount: 2
      },
      memory: [{ address: esBase + destOffset, bytes: bytesForWidth(width, value) }]
    }
  };
}

function stosFixture(width: OperandWidth, df: 0 | 1): EngineFixture {
  const value = valueForWidth(width);
  const step = stepFor(width, df);

  return {
    name: `stos-${width}-df${df}/trap`,
    bytes: withTrap(stosOpcode(width)),
    initialState: {
      eax: accumulatorInitial(width, value),
      edi: destOffset,
      esBase,
      DF: df,
      ...allStatusFlagsSet,
      eip: engineFixtureStartAddress
    },
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: accumulatorInitial(width, value),
        edi: u32(destOffset + step),
        esBase,
        DF: df,
        ...allStatusFlagsSet,
        eip: engineFixtureStartAddress + stosOpcode(width).length + trap.length,
        instructionCount: 2
      },
      memory: [{ address: esBase + destOffset, bytes: bytesForWidth(width, value) }]
    }
  };
}

function lodsFixture(width: OperandWidth, df: 0 | 1): EngineFixture {
  const value = valueForWidth(width);
  const step = stepFor(width, df);
  const initialEax = 0x1122_3344;

  return {
    name: `lods-${width}-df${df}/trap`,
    bytes: withTrap(lodsOpcode(width)),
    initialState: {
      eax: initialEax,
      esi: sourceAddress,
      DF: df,
      ...allStatusFlagsSet,
      eip: engineFixtureStartAddress
    },
    initialMemory: [
      { address: sourceAddress, bytes: bytesForWidth(width, value) }
    ],
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: accumulatorAfterLoad(width, initialEax, value),
        esi: u32(sourceAddress + step),
        DF: df,
        ...allStatusFlagsSet,
        eip: engineFixtureStartAddress + lodsOpcode(width).length + trap.length,
        instructionCount: 2
      }
    }
  };
}

function cmpsFixture(width: OperandWidth, df: 0 | 1): EngineFixture {
  const { left, right } = compareValues(width);
  const flags = aluReference("cmp", width, left, right).flags;
  const step = stepFor(width, df);

  return compareFixture({
    name: `cmps-${width}-df${df}/trap`,
    opcode: cmpsOpcode(width),
    width,
    df,
    left,
    right,
    expectedState: {
      esi: u32(sourceAddress + step),
      edi: u32(destOffset + step)
    },
    initialMemory: [
      { address: sourceAddress, bytes: bytesForWidth(width, left) },
      { address: esBase + destOffset, bytes: bytesForWidth(width, right) }
    ],
    flags
  });
}

function scasFixture(width: OperandWidth, df: 0 | 1): EngineFixture {
  const { left, right } = compareValues(width);
  const flags = aluReference("cmp", width, left, right).flags;
  const step = stepFor(width, df);

  return compareFixture({
    name: `scas-${width}-df${df}/trap`,
    opcode: scasOpcode(width),
    width,
    df,
    left,
    right,
    expectedState: {
      edi: u32(destOffset + step)
    },
    initialMemory: [
      { address: esBase + destOffset, bytes: bytesForWidth(width, right) }
    ],
    flags
  });
}

function compareFixture(
  input: Readonly<{
    name: string;
    opcode: readonly number[];
    width: OperandWidth;
    df: 0 | 1;
    left: number;
    right: number;
    expectedState: Partial<WasmCpuStateSnapshot>;
    initialMemory: readonly MemoryPatch[];
    flags: ReturnType<typeof aluReference>["flags"];
  }>
): EngineFixture {
  const initialEax = accumulatorInitial(input.width, input.left);
  const flagImage = lahfImage(input.flags);
  const expectedEax = (initialEax & 0xffff_00ff) | (flagImage << 8);
  const expectedEbx = 0x1234_5600 | input.flags.OF;

  return {
    name: input.name,
    bytes: withTrap([...input.opcode, 0x9f, 0x0f, 0x90, 0xc3]),
    initialState: {
      eax: initialEax,
      ebx: 0x1234_5600,
      esi: sourceAddress,
      edi: destOffset,
      esBase,
      DF: input.df,
      eip: engineFixtureStartAddress
    },
    initialMemory: input.initialMemory,
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: expectedEax >>> 0,
        ebx: expectedEbx,
        esBase,
        DF: input.df,
        ...input.expectedState,
        eip: engineFixtureStartAddress + input.opcode.length + 1 + 3 + trap.length,
        instructionCount: 4
      }
    }
  };
}

function movsOpcode(width: OperandWidth): readonly number[] {
  switch (width) {
    case 8:
      return [0xa4];
    case 16:
      return [0x66, 0xa5];
    case 32:
      return [0xa5];
  }
}

function repMovsOpcode(width: OperandWidth): readonly number[] {
  return [0xf3, ...movsOpcode(width)];
}

function cmpsOpcode(width: OperandWidth): readonly number[] {
  switch (width) {
    case 8:
      return [0xa6];
    case 16:
      return [0x66, 0xa7];
    case 32:
      return [0xa7];
  }
}

function repeCmpsOpcode(width: OperandWidth): readonly number[] {
  return [0xf3, ...cmpsOpcode(width)];
}

function stosOpcode(width: OperandWidth): readonly number[] {
  switch (width) {
    case 8:
      return [0xaa];
    case 16:
      return [0x66, 0xab];
    case 32:
      return [0xab];
  }
}

function lodsOpcode(width: OperandWidth): readonly number[] {
  switch (width) {
    case 8:
      return [0xac];
    case 16:
      return [0x66, 0xad];
    case 32:
      return [0xad];
  }
}

function scasOpcode(width: OperandWidth): readonly number[] {
  switch (width) {
    case 8:
      return [0xae];
    case 16:
      return [0x66, 0xaf];
    case 32:
      return [0xaf];
  }
}

function repneScasOpcode(width: OperandWidth): readonly number[] {
  return [0xf2, ...scasOpcode(width)];
}

function withTrap(bytes: readonly number[]): readonly number[] {
  return [...bytes, ...trap];
}

function stepFor(width: OperandWidth, df: 0 | 1): number {
  const byteLength = width / 8;

  return df === 0 ? byteLength : -byteLength;
}

function valueForWidth(width: OperandWidth): number {
  switch (width) {
    case 8:
      return 0x7c;
    case 16:
      return 0xbeef;
    case 32:
      return 0xcafe_babe;
  }
}

function compareValues(width: OperandWidth): Readonly<{ left: number; right: number }> {
  switch (width) {
    case 8:
      return { left: 0x80, right: 0x01 };
    case 16:
      return { left: 0x7fff, right: 0xffff };
    case 32:
      return { left: 0x8000_0000, right: 0x0000_0001 };
  }
}

function accumulatorInitial(width: OperandWidth, value: number): number {
  switch (width) {
    case 8:
      return (0x1122_3300 | (value & 0xff)) >>> 0;
    case 16:
      return (0x1122_0000 | (value & 0xffff)) >>> 0;
    case 32:
      return value >>> 0;
  }
}

function accumulatorAfterLoad(width: OperandWidth, initial: number, value: number): number {
  switch (width) {
    case 8:
      return ((initial & 0xffff_ff00) | (value & 0xff)) >>> 0;
    case 16:
      return ((initial & 0xffff_0000) | (value & 0xffff)) >>> 0;
    case 32:
      return value >>> 0;
  }
}

function bytesForWidth(width: OperandWidth, value: number): readonly number[] {
  switch (width) {
    case 8:
      return [value & 0xff];
    case 16:
      return [value & 0xff, (value >>> 8) & 0xff];
    case 32:
      return dwordBytes(value);
  }
}

function dwordBytes(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}

function lahfImage(flags: ReturnType<typeof aluReference>["flags"]): number {
  return 0x02 |
    flags.CF |
    (flags.PF << 2) |
    (flags.AF << 4) |
    (flags.ZF << 6) |
    (flags.SF << 7);
}

function u32(value: number): number {
  return value >>> 0;
}
