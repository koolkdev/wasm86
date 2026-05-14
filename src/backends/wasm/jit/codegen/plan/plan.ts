import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import { analyzeJitCodegenState } from "./state-plan.js";
import type { JitCodegenPlan } from "./types.js";

export type {
  ExitMaterializationStore,
  JitExitPoint,
  JitExitStateSnapshot,
  JitObservationPayload,
  JitObservationPoint,
  JitObservationRuntimeSource,
  JitObservationValue,
  JitExitMaterializationPlan,
  JitExitMaterializationStore,
  JitExitStoreMaterializationNeed,
  JitInstructionState,
  JitMaterializationNeed,
  JitMaterializationPlacement,
  MaterializationTarget,
  JitCodegenPlan
} from "./types.js";
export type {
  JitControlPathId,
  JitValuePathScope
} from "./control-paths.js";
export type {
  JitInstructionValueTimeline,
  JitInstructionValueTimelineInput,
  JitPlacedEffectiveAddressValue,
  JitPlacedExpressionValue,
  JitPlacedStorageRead,
  JitPlacedValueRefValue,
  JitTimelineProducedValueDefinition,
  JitValueTimelineWrite
} from "./value-timeline.js";
export type {
  JitEffectPlacement,
  JitEffectValueRoot,
  JitEffectValueRootPurpose,
  JitPlannedEffect
} from "./effect-plan.js";
export { buildJitInstructionValueTimeline } from "./value-timeline.js";

export function planJitCodegen(optimizedBlock: JitIrBlock): JitCodegenPlan {
  const state = analyzeJitCodegenState(optimizedBlock);

  return {
    ...state,
    block: optimizedBlock
  };
}
