import { preparedOpsFromBlockExpressions } from "#backends/wasm/jit/ir/block-expressions.js";
import {
  planReuseForBlock,
  type BlockReusePlan
} from "./reuse.js";
import type {
  JitCodegenPlan,
  PlannedExit,
  StoreStrategyPlan,
  StoreStrategySet
} from "./types.js";
import type { ValueUse } from "./value-uses.js";
import {
  planEffects
} from "./effects-plan.js";
import type { EffectsPlan } from "./effect-types.js";
import { planStoreStrategy } from "./store-strategy.js";
import { collectValueUses } from "./value-uses.js";

export type JitCodegenEmissionPlan = Readonly<{
  exits: readonly PlannedExit[];
  storeStrategy: StoreStrategyPlan;
  exitStoreSets: readonly StoreStrategySet[];
  maxExitStoreIndex: number;
  effects: EffectsPlan;
  valueUses: readonly ValueUse[];
  reusePlan: BlockReusePlan;
}>;

export function buildJitCodegenEmissionPlan(codegenPlan: JitCodegenPlan): JitCodegenEmissionPlan {
  const effects = planEffects(codegenPlan);
  const valueUses = collectValueUses({
    effects,
    exits: codegenPlan.exits
  });
  const reusePlan = planReuseForBlock(
    {
      expressionBlock: preparedOpsFromBlockExpressions(codegenPlan.analysis.expressions),
      valueTimeline: codegenPlan.analysis.timeline
    },
    valueUses,
    codegenPlan.exits
  );
  const storeStrategy = planStoreStrategy({
    exits: codegenPlan.exits,
    captures: reusePlan.captures
  });

  return {
    exits: codegenPlan.exits,
    storeStrategy,
    exitStoreSets: storeStrategy.exitStoreSets,
    maxExitStoreIndex: storeStrategy.maxExitStoreIndex,
    effects,
    valueUses,
    reusePlan
  };
}
