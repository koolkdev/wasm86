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
  planSchedule,
  scheduleInputForAnalysis
} from "./schedule.js";
import type { BlockSchedule } from "./schedule-types.js";
import { planStoreStrategy } from "./store-strategy.js";
import { collectValueUses } from "./value-uses.js";

export type JitCodegenEmissionPlan = Readonly<{
  exits: readonly PlannedExit[];
  storeStrategy: StoreStrategyPlan;
  exitStoreSets: readonly StoreStrategySet[];
  maxExitStoreIndex: number;
  schedule: BlockSchedule;
  valueUses: readonly ValueUse[];
  reusePlan: BlockReusePlan;
}>;

export function buildJitCodegenEmissionPlan(codegenPlan: JitCodegenPlan): JitCodegenEmissionPlan {
  const plannedExits = new Map(codegenPlan.exits.map((exit) => [exit.id, exit]));
  const schedule = planSchedule(scheduleInputForAnalysis({
    analysis: codegenPlan.analysis,
    plannedExits
  }));
  const valueUses = collectValueUses({
    schedule,
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
    schedule,
    valueUses,
    reusePlan
  };
}
