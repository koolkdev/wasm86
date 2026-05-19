import type { JitBlock } from "#backends/wasm/jit/ir/types.js";
import { analyzeBlock, type BlockAnalysis } from "#backends/wasm/jit/analysis/block.js";
import { buildBlockExpressions } from "#backends/wasm/jit/ir/block-expressions.js";
import type {
  EffectInfo,
  InstructionFlow
} from "#backends/wasm/jit/analysis/effects.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import { planExitStores } from "./exit-stores.js";
import type {
  JitCodegenPlan,
  PlannedExit,
  PlannedInstruction
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
  PlannedInstruction
} from "./types.js";
export type {
  Effect,
  EffectsPlan,
  Placement,
} from "./effect-types.js";

export function planJitCodegen(optimizedBlock: JitBlock): JitCodegenPlan {
  const expressions = buildBlockExpressions(optimizedBlock);
  const analysis = analyzeBlock(expressions);

  return planBlock(analysis);
}

export function planBlock(analysis: BlockAnalysis): JitCodegenPlan {
  const exitStorePlan = planExitStores(blockExits(analysis));
  const exits = Array.from(exitStorePlan.exits.values());
  const instructions = planInstructions(analysis, exitStorePlan.exits);

  return {
    analysis,
    instructions,
    exits
  };
}

function blockExits(analysis: BlockAnalysis): readonly Exit[] {
  return analysis.instructions.flatMap((instruction) => instruction.flow.exits);
}

function planInstructions(
  analysis: BlockAnalysis,
  plannedExits: ReadonlyMap<string, PlannedExit>
): readonly PlannedInstruction[] {
  return analysis.instructions.map((instruction) => {
    const flow = planInstructionFlow(instruction.flow, plannedExits);

    return {
      analysis: instruction,
      flow,
      exitCount: flow.exits.length
    };
  });
}

function planInstructionFlow(
  flow: InstructionFlow,
  plannedExits: ReadonlyMap<string, PlannedExit>
): InstructionFlow<PlannedExit> {
  return {
    effects: flow.effects.map((effect) => planEffectExits(effect, plannedExits)),
    exits: flow.exits.map((exit) => requiredPlannedExit(plannedExits, exit.id))
  };
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
