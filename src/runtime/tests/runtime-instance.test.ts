import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { StopReason } from "#x86/execution/run-result.js";
import { readWasmCpuState, type WasmCpuStateField } from "#runtime/tests/fixtures/cpu-state.js";
import { CompiledBlockDecodeError } from "#engines/jit/compiled-blocks/wasm-cache.js";
import { RuntimeMode } from "#runtime/execution/mode.js";
import { RuntimeInstance } from "#runtime/runtime-instance.js";
import {
  COUNTDOWN_BRANCH_TRAP,
  engineFixtureStartAddress,
  MEMORY_STORE_TRAP,
  MOV_ADD_TRAP
} from "./fixtures/programs.js";
import type { EngineFixture, MemoryPatch } from "./fixtures/types.js";

test("runtime instance evaluates a program in interpreter mode", () => {
  const runtime = createRuntime(MOV_ADD_TRAP, { mode: RuntimeMode.INTERPRETER });
  const result = runtime.run();

  assertFixtureResult(MOV_ADD_TRAP, runtime, result);
});

test("runtime instance evaluates a program in compiled-blocks mode", () => {
  const runtime = createRuntime(MOV_ADD_TRAP, { mode: RuntimeMode.COMPILED_BLOCKS });
  const result = runtime.run();

  assertFixtureResult(MOV_ADD_TRAP, runtime, result);
});

test("runtime instance compiled-blocks mode falls back to the interpreter when no block is available", () => {
  const runtime = createRuntime(MOV_ADD_TRAP, {
    mode: RuntimeMode.COMPILED_BLOCKS,
    compiledBlocks: {
      getOrCompile() {
        return undefined;
      }
    }
  });
  const result = runtime.run();

  assertFixtureResult(MOV_ADD_TRAP, runtime, result);
});

test("runtime instance exposes guest memory changes", () => {
  const runtime = createRuntime(MEMORY_STORE_TRAP, { mode: RuntimeMode.INTERPRETER });
  const result = runtime.run();

  assertFixtureResult(MEMORY_STORE_TRAP, runtime, result);
});

test("runtime instance stops at max instructions", () => {
  const runtime = createRuntime(COUNTDOWN_BRANCH_TRAP, { mode: RuntimeMode.INTERPRETER });
  const result = runtime.run({ maxInstructions: 4 });

  strictEqual(result.stopReason, StopReason.INSTRUCTION_LIMIT);
  strictEqual(runtime.memories.cpuState.instructionCount, 4);
});

test("runtime instance executes from guest memory even when eip is outside loaded code regions", () => {
  const runtime = new RuntimeInstance({
    cpuState: { eip: engineFixtureStartAddress }
  });
  const result = runtime.run({ maxInstructions: 1 });

  strictEqual(result.stopReason, StopReason.INSTRUCTION_LIMIT);
  strictEqual(runtime.memories.cpuState.eip, engineFixtureStartAddress + 2);
  strictEqual(runtime.memories.cpuState.instructionCount, 1);
});

test("runtime instance compiled-blocks mode does not fall back after block decode faults", () => {
  const runtime = new RuntimeInstance({
    program: {
      baseAddress: engineFixtureStartAddress,
      bytes: [0x90, 0xb8, 0x01]
    },
    cpuState: { eip: engineFixtureStartAddress },
    mode: RuntimeMode.COMPILED_BLOCKS
  });

  throws(() => runtime.run(), CompiledBlockDecodeError);
  strictEqual(runtime.memories.cpuState.instructionCount, 0);
});

function createRuntime(
  fixture: EngineFixture,
  options: Omit<ConstructorParameters<typeof RuntimeInstance>[0], "program" | "cpuState"> = {}
): RuntimeInstance {
  return new RuntimeInstance({
    ...options,
    program: { baseAddress: engineFixtureStartAddress, bytes: fixture.bytes },
    cpuState: fixture.initialState
  });
}

function assertFixtureResult(
  fixture: EngineFixture,
  runtime: RuntimeInstance,
  result: ReturnType<RuntimeInstance["run"]>
): void {
  for (const [field, expected] of Object.entries(fixture.expected.result)) {
    strictEqual(result[field as keyof typeof result], expected, `${fixture.name}: expected result.${field}`);
  }

  for (const [field, expected] of Object.entries(fixture.expected.state)) {
    strictEqual(
      readWasmCpuState(runtime.memories.cpuState)[field as WasmCpuStateField],
      expected,
      `${fixture.name}: expected state.${field}`
    );
  }

  assertMemoryPatches(runtime, fixture.expected.memory ?? []);
}

function assertMemoryPatches(runtime: RuntimeInstance, patches: readonly MemoryPatch[]): void {
  for (const patch of patches) {
    for (let index = 0; index < patch.bytes.length; index += 1) {
      const address = patch.address + index;
      const read = runtime.memories.guest.readU8(address);

      strictEqual(read.ok, true, `expected memory read at 0x${address.toString(16)} to succeed`);

      if (read.ok) {
        strictEqual(read.value, patch.bytes[index] ?? 0, `expected memory byte at 0x${address.toString(16)}`);
      }
    }
  }
}
