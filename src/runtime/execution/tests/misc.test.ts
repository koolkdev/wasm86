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
import type { EngineFixture } from "#runtime/tests/fixtures/types.js";
import type { WasmHostMemories } from "#wasm/host/memories.js";

const trap = [0xcd, 0x2e] as const;
const guestByteLength = 0x10000;
const allStatusFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

const fixtures = [
  {
    name: "xlat-honors-fs-override/trap",
    bytes: [0x64, 0xd7, ...trap],
    initialState: {
      eax: 0x1234_5605,
      ebx: 0x20,
      fsBase: 0x1000,
      ...allStatusFlagsSet,
      eip: engineFixtureStartAddress
    },
    initialMemory: [
      { address: 0x1025, bytes: [0xab] }
    ],
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 0x1234_56ab,
        ebx: 0x20,
        fsBase: 0x1000,
        ...allStatusFlagsSet,
        eip: engineFixtureStartAddress + 4,
        instructionCount: 2
      }
    }
  },
  {
    name: "xlat-read-guard-faults-at-ebx-plus-al",
    bytes: [0xd7],
    initialState: {
      eax: 0x1234_5601,
      ebx: guestByteLength - 1,
      eip: engineFixtureStartAddress
    },
    expected: {
      result: {
        stop: {
          kind: "cpuException",
          exception: { kind: "PF", linearAddress: guestByteLength, errorCode: 0 }
        }
      },
      state: {
        eax: 0x1234_5601,
        ebx: guestByteLength - 1,
        eip: engineFixtureStartAddress,
        instructionCount: 0
      }
    }
  },
  {
    name: "wait-falls-through/trap",
    bytes: [0x9b, ...trap],
    initialState: {
      eip: engineFixtureStartAddress
    },
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eip: engineFixtureStartAddress + 3,
        instructionCount: 2
      }
    }
  },
  {
    name: "forward-jcc-not-taken-falls-through-inside-block/trap",
    bytes: [
      0xb8, 0x07, 0x00, 0x00, 0x00,
      0x83, 0xf9, 0x00,
      0x74, 0x02,
      0x01, 0xc3,
      ...trap
    ],
    initialState: {
      ebx: 0x20,
      ecx: 1,
      eip: engineFixtureStartAddress
    },
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 7,
        ebx: 0x27,
        ecx: 1,
        eip: engineFixtureStartAddress + 14,
        instructionCount: 5
      }
    }
  },
  {
    name: "into-clear-falls-through-mid-block/trap",
    bytes: [
      0xb8, 0x01, 0x00, 0x00, 0x00,
      0xce,
      0xbb, 0x02, 0x00, 0x00, 0x00,
      ...trap
    ],
    initialState: {
      OF: 0,
      eip: engineFixtureStartAddress
    },
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 1,
        ebx: 2,
        OF: 0,
        eip: engineFixtureStartAddress + 13,
        instructionCount: 4
      }
    }
  },
  {
    name: "into-set-traps-mid-block",
    bytes: [
      0xb8, 0x01, 0x00, 0x00, 0x00,
      0xce,
      0xbb, 0x02, 0x00, 0x00, 0x00,
      ...trap
    ],
    initialState: {
      ebx: 0x55,
      OF: 1,
      eip: engineFixtureStartAddress
    },
    expected: {
      result: { stop: { kind: "hostTrap", vector: 4 } },
      state: {
        eax: 1,
        ebx: 0x55,
        OF: 1,
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
    engines: createFixtureCompiledOnlyEngines
  }
] as const satisfies readonly {
  name: string;
  mode: RuntimeMode;
  engines(memories: WasmHostMemories): RuntimeEngines;
}[];

for (const fixture of fixtures) {
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
