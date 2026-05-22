import { analyzeBlock, type BlockAnalysis } from "#backends/wasm/jit/analysis/block.js";
import type { BlockExpressions } from "#backends/wasm/jit/ir/block-expressions.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import { planExitStores } from "./exit-stores.js";
import type {
  JitCodegenPlan
} from "./types.js";

export type {
  ExitStore,
  ExitStorePlan,
  PlannedExit,
  PlannedExitStore,
  PlannedExitStores,
  StoreSourceStrategy,
  StoreStrategyInput,
  StoreStrategyPlan,
  StoreStrategySet,
  JitCodegenPlan,
} from "./types.js";
export type {
  BlockSchedule,
  BlockScheduleEntry,
  FallthroughEntry,
  HostTrapEntry,
  MemoryLoadValueEntry,
  MemoryGuardEntry,
  MemoryStoreEntry,
  Placement,
  RuntimeEntry,
  DefinitionEntry,
} from "./schedule-types.js";
export type {
  ScheduleAnalysisInput,
  ScheduleInput,
  ScheduleOp
} from "./schedule.js";
export { planSchedule, scheduleInputForAnalysis } from "./schedule.js";

export function planJitCodegen(expressions: BlockExpressions): JitCodegenPlan {
  return planBlock(analyzeBlock(expressions));
}

export function planBlock(analysis: BlockAnalysis): JitCodegenPlan {
  const exitStorePlan = planExitStores(blockExits(analysis));
  const exits = Array.from(exitStorePlan.exits.values());

  return {
    analysis,
    exits
  };
}

function blockExits(analysis: BlockAnalysis): readonly Exit[] {
  return analysis.runtime.exits;
}
