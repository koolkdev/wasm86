import { strictEqual } from "node:assert";
import { test } from "node:test";

import { runResultFromExecutionState } from "#driver/results.js";
import { createWasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { RuntimeCodeMap } from "#runtime/program/code-map.js";
import {
  assertEngineFixtureResult,
  createFixtureFallbackEngines,
  createFixtureInterpreterOnlyEngines,
  createFixtureRuntimeEngines,
  prepareEngineFixture
} from "#runtime/tests/fixtures/helpers.js";
import { ENGINE_PROGRAM_FIXTURES, MOV_ADD_TRAP } from "#runtime/tests/fixtures/programs.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";
import { createInstructionBudget } from "#runtime/execution/budget.js";
import { engineDone, engineUnavailable, type RuntimeEngineResult } from "#runtime/execution/engine-result.js";
import { RuntimeMode } from "#runtime/execution/mode.js";
import {
  runRuntimeProgram,
  runRuntimeStep,
  type RuntimeEngine,
  type RuntimeEngineContext
} from "#runtime/execution/runner.js";

test("interpreter runtime step runs only the interpreter engine", () => {
  const calls: string[] = [];
  const result = runRuntimeStep(RuntimeMode.INTERPRETER, context(), createInstructionBudget(0, 10), {
    interpreter: engine("interpreter", calls, engineDone(runResultFromExecutionState(createWasmCpuStateSnapshot({ eip: 0x11 }), { kind: "none" }))),
    compiledBlocks: engine("compiled", calls, engineUnavailable("no-compiled-block"))
  });

  strictEqual(result.kind, "done");
  strictEqual(result.kind === "done" ? result.result.finalEip : 0, 0x11);
  strictEqual(calls.join(","), "interpreter");
});

test("compiled-blocks runtime step falls back to interpreter when no block is available", () => {
  const calls: string[] = [];
  const result = runRuntimeStep(RuntimeMode.COMPILED_BLOCKS, context(), createInstructionBudget(0, 10), {
    interpreter: engine("interpreter", calls, engineDone(runResultFromExecutionState(createWasmCpuStateSnapshot({ eip: 0x22 }), { kind: "none" }))),
    compiledBlocks: engine("compiled", calls, engineUnavailable("no-compiled-block"))
  });

  strictEqual(result.kind, "done");
  strictEqual(result.kind === "done" ? result.result.finalEip : 0, 0x22);
  strictEqual(calls.join(","), "compiled,interpreter");
});

test("compiled-blocks runtime step returns compiled result when available", () => {
  const calls: string[] = [];
  const result = runRuntimeStep(RuntimeMode.COMPILED_BLOCKS, context(), createInstructionBudget(0, 10), {
    interpreter: engine("interpreter", calls, engineDone(runResultFromExecutionState(createWasmCpuStateSnapshot({ eip: 0x11 }), { kind: "none" }))),
    compiledBlocks: engine("compiled", calls, engineDone(runResultFromExecutionState(createWasmCpuStateSnapshot({ eip: 0x33 }), { kind: "none" })))
  });

  strictEqual(result.kind, "done");
  strictEqual(result.kind === "done" ? result.result.finalEip : 0, 0x33);
  strictEqual(calls.join(","), "compiled");
});

for (const fixture of ENGINE_PROGRAM_FIXTURES) {
  test(`interpreter executor evaluates ${fixture.name}`, () => {
    const { codeMap, memories } = prepareEngineFixture(fixture);
    const result = runRuntimeProgram(
      RuntimeMode.INTERPRETER,
      { codeMap, memories },
      createInstructionBudget(0, 100),
      createFixtureInterpreterOnlyEngines(memories)
    );

    assertEngineFixtureResult(fixture, result, memories);
  });
}

for (const fixture of ENGINE_PROGRAM_FIXTURES) {
  test(`compiled-blocks executor evaluates ${fixture.name}`, () => {
    const { codeMap, memories } = prepareEngineFixture(fixture);
    const result = runRuntimeProgram(
      RuntimeMode.COMPILED_BLOCKS,
      { codeMap, memories },
      createInstructionBudget(0, 100),
      createFixtureRuntimeEngines(memories)
    );

    assertEngineFixtureResult(fixture, result, memories);
  });
}

test("compiled-blocks executor can fall back to interpreter and still evaluate the program", () => {
  const { codeMap, memories } = prepareEngineFixture(MOV_ADD_TRAP);
  const result = runRuntimeProgram(
    RuntimeMode.COMPILED_BLOCKS,
    { codeMap, memories },
    createInstructionBudget(0, 100),
    createFixtureFallbackEngines(memories)
  );

  assertEngineFixtureResult(MOV_ADD_TRAP, result, memories);
});

function context(): RuntimeEngineContext {
  return {
    codeMap: new RuntimeCodeMap([]),
    memories: createWasmHostMemories()
  };
}

function engine(name: string, calls: string[], result: RuntimeEngineResult): RuntimeEngine {
  return {
    run() {
      calls.push(name);
      return result;
    }
  };
}
