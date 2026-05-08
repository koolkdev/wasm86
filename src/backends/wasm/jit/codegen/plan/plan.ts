import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import { analyzeJitCodegenState } from "./exit-state-analysis.js";
import type { JitCodegenPlan } from "./types.js";

export type {
  JitInstructionEntryPoint,
  JitExitPoint,
  JitExitSnapshotKind,
  JitExitMaterializationPlan,
  JitExitMaterializationStore,
  JitFlagMaterializationRequirement,
  JitFlagSnapshot,
  JitInstructionState,
  JitMaterializationConsumer,
  JitMaterializationNeed,
  JitMaterializationPlacement,
  JitMaterializationPathScope,
  JitMaterializationValue,
  JitPreInstructionExitPlan,
  JitCodegenPlan,
  JitStateSnapshot
} from "./types.js";

export function planJitCodegen(optimizedBlock: JitIrBlock): JitCodegenPlan {
  const state = analyzeJitCodegenState(optimizedBlock);

  return {
    ...state,
    block: optimizedBlock
  };
}
