import type {
  BlockAnalysis,
  InstructionAnalysis,
  InstructionFlow
} from "#backends/wasm/jit/analysis/block.js";
import type { PlannedExit } from "./exit-stores.js";

export type {
  ExitStore,
  ExitStorePlan,
  PlannedExit
} from "./exit-stores.js";
export type {
  PlannedExitStore,
  PlannedExitStores,
  StoreSourceStrategy,
  StoreStrategyInput,
  StoreStrategyPlan,
  StoreStrategySet
} from "./store-strategy.js";

export type PlannedInstruction = Readonly<{
  analysis: InstructionAnalysis;
  flow: InstructionFlow<PlannedExit>;
  exitCount: number;
}>;

export type JitCodegenPlan = Readonly<{
  analysis: BlockAnalysis;
  instructions: readonly PlannedInstruction[];
  exits: readonly PlannedExit[];
}>;
