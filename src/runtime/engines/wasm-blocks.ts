import type { InstructionBudget } from "#runtime/execution/budget.js";
import {
  engineDone,
  engineUnavailable,
  type RuntimeEngineResult,
  type RuntimeEngineUnavailableReason
} from "#runtime/execution/engine-result.js";
import type { RuntimeEngine, RuntimeEngineContext } from "#runtime/execution/runner.js";
import { runResultFromWasmExit } from "#runtime/execution/wasm-exit-result.js";
import type { CompiledBlockCache } from "#engines/jit/compiled-blocks/block-cache.js";

export class WasmBlocksEngine implements RuntimeEngine {
  constructor(
    readonly blockCache: CompiledBlockCache,
    readonly unavailableReason: RuntimeEngineUnavailableReason = "no-compiled-block"
  ) {}

  run(context: RuntimeEngineContext, _budget: InstructionBudget): RuntimeEngineResult {
    const block = this.blockCache.getOrCompile(
      context.memories.cpuState.eip,
      context.codeMap,
      context.memories
    );

    if (block === undefined) {
      return engineUnavailable(this.unavailableReason);
    }

    return engineDone(runResultFromWasmExit(context.memories.cpuState, block.run().exit));
  }
}
