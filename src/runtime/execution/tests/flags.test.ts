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

const fixtures = [
  {
    name: "cmc-resolves-lazy-cf/trap",
    // add eax, 1; cmc; int 0x2e
    bytes: [0x83, 0xc0, 0x01, 0xf5, ...trap],
    initialState: {
      eax: 0xffff_ffff,
      eip: engineFixtureStartAddress
    },
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 0,
        eip: engineFixtureStartAddress + 6,
        instructionCount: 3,
        CF: 0,
        PF: 1,
        AF: 1,
        ZF: 1,
        SF: 0,
        OF: 0,
        lazyFlagsKind: 0
      }
    }
  },
  {
    name: "std-cld-round-trip-through-pushfd/trap",
    // std; pushfd; pop eax; cld; pushfd; pop ebx; int 0x2e
    bytes: [0xfd, 0x9c, 0x58, 0xfc, 0x9c, 0x5b, ...trap],
    initialState: {
      esp: 0x80,
      eip: engineFixtureStartAddress
    },
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 0x602,
        ebx: 0x202,
        esp: 0x80,
        DF: 0,
        eip: engineFixtureStartAddress + 8,
        instructionCount: 7
      }
    }
  },
  {
    name: "sahf-lahf-round-trip-low-flags/trap",
    // sahf; lahf; int 0x2e
    bytes: [0x9e, 0x9f, ...trap],
    initialState: {
      eax: 0x1234_6f00,
      OF: 1,
      eip: engineFixtureStartAddress
    },
    expected: {
      result: { stop: { kind: "hostTrap", vector: 0x2e } },
      state: {
        eax: 0x1234_4700,
        CF: 1,
        PF: 1,
        AF: 0,
        ZF: 1,
        SF: 0,
        OF: 1,
        eip: engineFixtureStartAddress + 4,
        instructionCount: 3
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
