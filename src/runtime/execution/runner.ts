import type { RuntimeCodeMap } from "#runtime/program/code-map.js";
import type { WasmHostMemories } from "#wasm/host/memories.js";
import { runResultFromExecutionState } from "#driver/results.js";
import type { InstructionBudget } from "./budget.js";
import { engineDone, type RuntimeEngineResult } from "./engine-result.js";
import { RuntimeMode, type RuntimeMode as RuntimeModeValue } from "./mode.js";

export type RuntimeEngineContext = Readonly<{
  codeMap: RuntimeCodeMap;
  memories: WasmHostMemories;
}>;

export type RuntimeEngine = Readonly<{
  run(context: RuntimeEngineContext, budget: InstructionBudget): RuntimeEngineResult;
}>;

export type RuntimeEngines = Readonly<{
  interpreter: RuntimeEngine;
  compiledBlocks: RuntimeEngine;
}>;

export function runRuntimeStep(
  mode: RuntimeModeValue,
  context: RuntimeEngineContext,
  budget: InstructionBudget,
  engines: RuntimeEngines
): RuntimeEngineResult {
  switch (mode) {
    case RuntimeMode.INTERPRETER:
      return engines.interpreter.run(context, budget);
    case RuntimeMode.COMPILED_BLOCKS: {
      const compiled = engines.compiledBlocks.run(context, budget);

      return compiled.kind === "done"
        ? compiled
        : engines.interpreter.run(context, budget);
    }
  }
}

export function runRuntimeProgram(
  mode: RuntimeModeValue,
  context: RuntimeEngineContext,
  budget: InstructionBudget,
  engines: RuntimeEngines
): RuntimeEngineResult {
  while (!budget.exhausted(context.memories.cpuState.instructionCount)) {
    const previousInstructionCount = context.memories.cpuState.instructionCount;
    const result = runRuntimeStep(mode, context, budget, engines);

    if (result.kind !== "done" || result.result.stop.kind !== "none") {
      return result;
    }

    if (context.memories.cpuState.instructionCount === previousInstructionCount) {
      throw new Error("runtime executor made no instruction progress");
    }
  }

  return stopWithInstructionLimit(context);
}

function stopWithInstructionLimit(context: RuntimeEngineContext): RuntimeEngineResult {
  return engineDone(runResultFromExecutionState(context.memories.cpuState, { kind: "instructionLimit" }));
}
