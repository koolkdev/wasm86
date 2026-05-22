import { analyzeBlock, type BlockAnalysis } from "#backends/wasm/jit/analysis/block.js";
import type { BlockExpressions } from "#backends/wasm/jit/ir/block-expressions.js";
import type { EffectInfo } from "#backends/wasm/jit/analysis/effects.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import { planExitStores } from "./exit-stores.js";
import type {
  JitCodegenPlan,
  PlannedExit
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
  Effect,
  EffectsPlan,
  Placement,
} from "./effect-types.js";

export function planJitCodegen(expressions: BlockExpressions): JitCodegenPlan {
  return planBlock(analyzeBlock(expressions));
}

export function planBlock(analysis: BlockAnalysis): JitCodegenPlan {
  const exitStorePlan = planExitStores(blockExits(analysis));
  const exits = Array.from(exitStorePlan.exits.values());
  const effects = planEffectInfos(analysis.effectAnalysis.effects, exitStorePlan.exits);

  return {
    analysis,
    effects,
    exits
  };
}

function blockExits(analysis: BlockAnalysis): readonly Exit[] {
  return analysis.effectAnalysis.exits;
}

function planEffectInfos(
  effects: readonly EffectInfo[],
  plannedExits: ReadonlyMap<string, PlannedExit>
): readonly EffectInfo<PlannedExit>[] {
  return effects.map((effect) => planEffectExits(effect, plannedExits));
}

function planEffectExits(
  effect: EffectInfo,
  plannedExits: ReadonlyMap<string, PlannedExit>
): EffectInfo<PlannedExit> {
  switch (effect.kind) {
    case "memoryGuard":
      return {
        ...effect,
        faultExit: requiredPlannedExit(plannedExits, effect.faultExit.id)
      };
    case "jump":
    case "hostTrap":
    case "fallthrough":
      return {
        ...effect,
        exit: requiredPlannedExit(plannedExits, effect.exit.id)
      };
    case "branch":
      return {
        ...effect,
        taken: requiredPlannedExit(plannedExits, effect.taken.id),
        notTaken: requiredPlannedExit(plannedExits, effect.notTaken.id)
      };
    case "memoryStore":
    case "memoryLoad":
      return effect;
  }
}

function requiredPlannedExit(
  plannedExits: ReadonlyMap<string, PlannedExit>,
  exitId: string
): PlannedExit {
  const exit = plannedExits.get(exitId);

  if (exit === undefined) {
    throw new Error(`missing planned JIT exit: ${exitId}`);
  }

  return exit;
}
