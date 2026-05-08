import type { Reg32 } from "#x86/isa/types.js";
import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";

export type JitExitSnapshotKind = "preInstruction" | "postInstruction";

export type JitFlagSnapshot = Readonly<{
  mask: number;
}>;

export type JitStateSnapshot = Readonly<{
  kind: JitExitSnapshotKind;
  eip: number;
  instructionCountDelta: number;
  committedRegs: readonly Reg32[];
  speculativeRegs: readonly Reg32[];
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
  reason: "condition" | "exit";
  requiredMask: number;
  pendingMask: number;
}>;

export type JitMaterializationValue =
  | Readonly<{ kind: "committedRegister"; reg: Reg32 }>
  | Readonly<{ kind: "exitFlags"; mask: number }>;

export type JitMaterializationConsumer =
  | "registerExitStore"
  | "flagExitStore";

export type JitMaterializationPlacement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  exitPointIndex: number;
  exitReason: ExitReasonValue;
  exitMaterializationIndex: number;
}>;

export type JitMaterializationPathScope = "taken" | "notTaken" | "deferredExit";

export type JitMaterializationNeed = Readonly<{
  value: JitMaterializationValue;
  consumer: JitMaterializationConsumer;
  placement: JitMaterializationPlacement;
  pathScope: JitMaterializationPathScope;
}>;

export type JitExitMaterializationStore =
  | Readonly<{
      kind: "register";
      target: Reg32;
      source: Extract<JitMaterializationValue, { kind: "committedRegister" }>;
    }>;

export type JitPreInstructionExitPlan = Readonly<{
  exitPointCount: number;
  preserveCommittedRegs: boolean;
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
  // Flags remain on the legacy mask path until flag materialization stores are
  // migrated to the generic store model.
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
