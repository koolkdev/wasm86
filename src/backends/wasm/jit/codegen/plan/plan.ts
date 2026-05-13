import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import { analyzeJitCodegenState } from "./exit-state-analysis.js";
import type { JitCodegenPlan } from "./types.js";

export type {
  JitInstructionEntryPoint,
  ExitMaterializationStore,
  JitExitPoint,
  JitExitSnapshotKind,
  JitExitMaterializationPlan,
  JitExitMaterializationStore,
  JitInstructionState,
  JitMaterializationConsumer,
  JitMaterializationNeed,
  JitMaterializationPlacement,
  JitMaterializationPathScope,
  MaterializationTarget,
  JitPreInstructionExitPlan,
  JitCodegenPlan,
  JitStateSnapshot
} from "./types.js";
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
export { buildJitInstructionValueTimeline } from "./value-timeline.js";

export function planJitCodegen(optimizedBlock: JitIrBlock): JitCodegenPlan {
  const state = analyzeJitCodegenState(optimizedBlock);

  return {
    ...state,
    block: optimizedBlock
  };
}
