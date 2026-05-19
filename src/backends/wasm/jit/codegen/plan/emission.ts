import type { InstructionReusePlan } from "./reuse.js";
import type {
  JitCodegenPlan,
  PlannedInstruction,
  PlannedExit,
  StoreStrategyPlan,
  StoreStrategySet
} from "./types.js";
import {
  planReuseForEmission,
  type InstructionWithReusePlan
} from "./value-planning.js";
import type { ValueUse } from "./value-uses.js";
import {
  planEffects
} from "./effects-plan.js";
import type { EffectsPlan } from "./effect-types.js";
import { planStoreStrategy } from "./store-strategy.js";
import { collectValueUses } from "./value-uses.js";

export type JitCodegenInstructionPlan =
  InstructionWithReusePlan<PlannedInstruction>;

export type JitCodegenEmissionPlan = Readonly<{
  instructions: readonly JitCodegenInstructionPlan[];
  exits: readonly PlannedExit[];
  storeStrategy: StoreStrategyPlan;
  exitStoreSets: readonly StoreStrategySet[];
  maxExitStoreIndex: number;
  effects: EffectsPlan;
  valueUses: readonly ValueUse[];
  reusePlan: InstructionReusePlan;
}>;

export function buildJitCodegenEmissionPlan(codegenPlan: JitCodegenPlan): JitCodegenEmissionPlan {
  const effects = planEffects(codegenPlan.instructions);
  const valueUses = collectValueUses({
    effects,
    exits: codegenPlan.exits
  });
  const plannedValues = planReuseForEmission(
    codegenPlan.instructions,
    valueUses,
    codegenPlan.exits
  );
  const storeStrategy = planStoreStrategy({
    exits: codegenPlan.exits,
    captures: plannedValues.reusePlan.captures
  });

  return {
    instructions: plannedValues.instructions,
    exits: codegenPlan.exits,
    storeStrategy,
    exitStoreSets: storeStrategy.exitStoreSets,
    maxExitStoreIndex: storeStrategy.maxExitStoreIndex,
    effects,
    valueUses: plannedValues.valueUses,
    reusePlan: plannedValues.reusePlan
  };
}
