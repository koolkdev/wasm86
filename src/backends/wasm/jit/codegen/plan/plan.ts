import type { JitBlock } from "#backends/wasm/jit/ir/types.js";
import { analyzeJitCodegenState } from "./state-plan.js";
import type { JitCodegenPlan } from "./types.js";

export type {
  Exit,
  ExitPayload,
  ExitRuntimeSource,
  ExitSnapshot,
  ExitValue,
  ExitStore,
  ExitStorePlan,
  ExitStoreSet,
  PlannedExit,
  JitInstructionState,
  JitCodegenPlan
} from "./types.js";
export type {
  PathId,
  Path
} from "#backends/wasm/jit/analysis/paths.js";
export type {
  Timeline,
  TimelineInput,
  PlacedStorageRead,
  ProducedDefinition,
  SlotWrite,
  TimelineLookups
} from "#backends/wasm/jit/analysis/timeline.js";
export type {
  EffectPlacement,
  EffectValueRoot,
  EffectValueRootPurpose,
  PlannedEffect
} from "./effect-plan.js";
export { buildTimeline } from "#backends/wasm/jit/analysis/timeline.js";

export function planJitCodegen(optimizedBlock: JitBlock): JitCodegenPlan {
  const state = analyzeJitCodegenState(optimizedBlock);

  return {
    ...state,
    block: optimizedBlock
  };
}
