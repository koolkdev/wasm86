import { test } from "node:test";

import { createInstructionBudget } from "#runtime/execution/budget.js";
import { RuntimeMode } from "#runtime/execution/mode.js";
import { runRuntimeProgram } from "#runtime/execution/runner.js";
import {
  assertEngineFixtureResult,
  createFixtureInterpreterOnlyEngines,
  createFixtureRuntimeEngines,
  prepareEngineFixture
} from "#runtime/tests/fixtures/helpers.js";
import { engineFixtureStartAddress } from "#runtime/tests/fixtures/programs.js";
import type { EngineFixture } from "#runtime/tests/fixtures/types.js";
import type { WasmHostMemories } from "#wasm/host/memories.js";

const trap = [0xcd, 0x2e] as const;

const segmentOverrideFixtures = [
  {
    name: "fs-override/modrm-load/trap",
    bytes: [...withTrap([0x64, 0x8b, 0x03])],
    initialState: {
      ebx: 0x20,
      fsBase: 0x1000,
      eip: engineFixtureStartAddress
    },
    initialMemory: [
      { address: 0x1020, bytes: dwordBytes(0x1234_5678) }
    ],
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 0x1234_5678,
        ebx: 0x20,
        fsBase: 0x1000,
        eip: engineFixtureStartAddress + 5,
        instructionCount: 2
      }
    }
  },
  {
    name: "gs-override/moffs-store/trap",
    bytes: [...withTrap([0x65, 0xa3, 0x30, 0x00, 0x00, 0x00])],
    initialState: {
      eax: 0xcafe_babe,
      gsBase: 0x2000,
      eip: engineFixtureStartAddress
    },
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 0xcafe_babe,
        gsBase: 0x2000,
        eip: engineFixtureStartAddress + 8,
        instructionCount: 2
      },
      memory: [
        { address: 0x2030, bytes: dwordBytes(0xcafe_babe) }
      ]
    }
  },
  {
    name: "fs-override/disp32-no-base-load/trap",
    bytes: [...withTrap([0x64, 0x8b, 0x05, 0x30, 0x00, 0x00, 0x00])],
    initialState: {
      fsBase: 0x1000,
      eip: engineFixtureStartAddress
    },
    initialMemory: [
      { address: 0x1030, bytes: dwordBytes(0xfeed_face) }
    ],
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 0xfeed_face,
        fsBase: 0x1000,
        eip: engineFixtureStartAddress + 9,
        instructionCount: 2
      }
    }
  },
  {
    name: "segment-then-operand-size-prefixes/trap",
    bytes: [...withTrap([0x64, 0x66, 0x8b, 0x03])],
    initialState: {
      eax: 0xffff_0000,
      ebx: 0x20,
      fsBase: 0x1000,
      eip: engineFixtureStartAddress
    },
    initialMemory: [
      { address: 0x1020, bytes: wordBytes(0x1234) }
    ],
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 0xffff_1234,
        ebx: 0x20,
        fsBase: 0x1000,
        eip: engineFixtureStartAddress + 6,
        instructionCount: 2
      }
    }
  },
  {
    name: "operand-size-then-segment-prefixes/trap",
    bytes: [...withTrap([0x66, 0x64, 0x8b, 0x03])],
    initialState: {
      eax: 0xffff_0000,
      ebx: 0x20,
      fsBase: 0x1000,
      eip: engineFixtureStartAddress
    },
    initialMemory: [
      { address: 0x1020, bytes: wordBytes(0x1234) }
    ],
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 0xffff_1234,
        ebx: 0x20,
        fsBase: 0x1000,
        eip: engineFixtureStartAddress + 6,
        instructionCount: 2
      }
    }
  },
  {
    name: "repeated-segment-prefixes-last-wins/trap",
    bytes: [...withTrap([0x64, 0x65, 0x8b, 0x03])],
    initialState: {
      ebx: 0x20,
      fsBase: 0x1000,
      gsBase: 0x2000,
      eip: engineFixtureStartAddress
    },
    initialMemory: [
      { address: 0x1020, bytes: dwordBytes(0x1111_1111) },
      { address: 0x2020, bytes: dwordBytes(0x2222_2222) }
    ],
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 0x2222_2222,
        ebx: 0x20,
        fsBase: 0x1000,
        gsBase: 0x2000,
        eip: engineFixtureStartAddress + 6,
        instructionCount: 2
      }
    }
  }
] as const satisfies readonly EngineFixture[];

const modes = [
  {
    name: "interpreter",
    mode: RuntimeMode.INTERPRETER,
    engines: createFixtureInterpreterOnlyEngines
  },
  {
    name: "compiled-blocks",
    mode: RuntimeMode.COMPILED_BLOCKS,
    engines: createFixtureRuntimeEngines
  }
] as const satisfies readonly {
  name: string;
  mode: RuntimeMode;
  engines(memories: WasmHostMemories): ReturnType<typeof createFixtureRuntimeEngines>;
}[];

for (const fixture of segmentOverrideFixtures) {
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

function withTrap(bytes: readonly number[]): readonly number[] {
  return [...bytes, ...trap];
}

function wordBytes(value: number): readonly number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function dwordBytes(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}
