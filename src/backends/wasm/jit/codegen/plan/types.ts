import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import type { JitValue } from "#backends/wasm/jit/ir/values.js";
import type { JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";
export type {
  ExitMaterializationStore,
  MaterializationTarget
} from "#backends/wasm/jit/ir/materialization.js";
import type {
  ExitMaterializationStore,
  MaterializationTarget
} from "#backends/wasm/jit/ir/materialization.js";

export type JitExitSnapshotKind = "preInstruction" | "postInstruction";

export type JitFlagSnapshot = Readonly<{
  mask: number;
}>;

export type JitStateSnapshot = Readonly<{
  kind: JitExitSnapshotKind;
  eip: number;
  instructionCountDelta: number;
  valueState: JitValueStateSnapshot;
  committedFlags: JitFlagSnapshot;
  speculativeFlags: JitFlagSnapshot;
}>;

export type JitExitPoint = Readonly<{
  instructionIndex: number;
  opIndex: number;
  exitReason: ExitReasonValue;
  snapshot: JitStateSnapshot;
  exitMaterializationIndex: number;
}>;

export type JitFlagMaterializationRequirement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  reason: "exit";
  requiredMask: number;
  pendingMask: number;
}>;

export type JitMaterializationConsumer =
  | "flagExitStore"
  | "registerExitStore";

export type JitMaterializationPlacement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  exitPointIndex: number;
  exitReason: ExitReasonValue;
  exitMaterializationIndex: number;
}>;

export type JitMaterializationPathScope = "taken" | "notTaken" | "deferredExit";

export type JitExitStoreMaterializationNeed = Readonly<{
  consumer: JitMaterializationConsumer;
  target: MaterializationTarget;
  value: JitValue;
  placement: JitMaterializationPlacement;
  pathScope: JitMaterializationPathScope;
}>;

export type JitMaterializationNeed = JitExitStoreMaterializationNeed;

export type JitExitMaterializationStore = ExitMaterializationStore;

export type JitPreInstructionExitPlan = Readonly<{
  exitPointCount: number;
}>;

export type JitInstructionEntryPoint = Readonly<{
  instructionIndex: number;
  snapshot: JitStateSnapshot;
  preInstructionExitPlan?: JitPreInstructionExitPlan;
}>;

export type JitInstructionState = Readonly<{
  instructionId: string;
  eip: number;
  nextEip: number;
  nextMode: "continue" | "exit";
  entryPoint: JitInstructionEntryPoint;
  postInstructionState: JitStateSnapshot;
  exitPointCount: number;
}>;

export type JitExitMaterializationPlan = Readonly<{
  stores: readonly JitExitMaterializationStore[];
  // Retained for legacy flag-state emission paths. Snapshot-derived flag exit
  // stores use stores[] with an aluFlags target and leave this mask empty.
  flagMask: number;
}>;

export type JitCodegenPlan = Readonly<{
  block: JitIrBlock;
  instructionStates: readonly JitInstructionState[];
  exitPoints: readonly JitExitPoint[];
  flagMaterializationRequirements: readonly JitFlagMaterializationRequirement[];
  materializationNeeds: readonly JitMaterializationNeed[];
  exitMaterializations: readonly JitExitMaterializationPlan[];
  maxExitMaterializationIndex: number;
}>;
