import type { BlockAnalysis } from "#backends/wasm/jit/analysis/block.js";
import type { EffectInfo } from "#backends/wasm/jit/analysis/effects.js";
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

export type JitCodegenPlan = Readonly<{
  analysis: BlockAnalysis;
  effects: readonly EffectInfo<PlannedExit>[];
  exits: readonly PlannedExit[];
}>;
