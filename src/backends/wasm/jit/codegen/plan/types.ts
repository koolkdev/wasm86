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

export type JitBoundaryRef = Readonly<{
  instructionIndex: number;
  boundaryIndex: number;
}>;

export type JitBoundaryState = Readonly<{
  boundary: JitBoundaryRef;
  instructionCountDelta: number;
  valueState: JitValueStateSnapshot;
}>;

export type JitObservationRuntimeSource =
  | "controlTarget"
  | "hostTrapVector"
  | "memoryAddress";

export type JitObservationValue =
  | Readonly<{ kind: "static"; value: number }>
  | Readonly<{ kind: "runtime"; source: JitObservationRuntimeSource }>;

export type JitObservationPayload = JitObservationValue;

export type JitMaterializationPathScope = "taken" | "notTaken" | "deferredExit";

export type JitObservationPoint = Readonly<{
  instructionIndex: number;
  opIndex: number;
  emitBoundary: JitBoundaryRef;
  observedBoundary: JitBoundaryRef;
  observedState: JitBoundaryState;
  visibleEip: JitObservationValue;
  exitReason: ExitReasonValue;
  payload: JitObservationPayload;
  pathScope: JitMaterializationPathScope;
  exitMaterializationIndex: number;
}>;

export type JitExitPoint = JitObservationPoint;

export type JitMaterializationConsumer =
  | "flagExitStore"
  | "registerExitStore";

export type JitMaterializationPlacement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  emitBoundary: JitBoundaryRef;
  observedBoundary: JitBoundaryRef;
  observationIndex: number;
  exitPointIndex: number;
  exitReason: ExitReasonValue;
  exitMaterializationIndex: number;
}>;

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
  boundaryState: JitBoundaryState;
  preInstructionExitPlan?: JitPreInstructionExitPlan;
}>;

export type JitInstructionState = Readonly<{
  instructionId: string;
  eip: number;
  nextEip: number;
  nextMode: "continue" | "exit";
  entryPoint: JitInstructionEntryPoint;
  postInstructionState: JitBoundaryState;
  exitPointCount: number;
}>;

export type JitExitMaterializationPlan = Readonly<{
  stores: readonly JitExitMaterializationStore[];
}>;

export type JitCodegenPlan = Readonly<{
  block: JitIrBlock;
  instructionStates: readonly JitInstructionState[];
  boundaryStates: readonly JitBoundaryState[];
  exitPoints: readonly JitExitPoint[];
  materializationNeeds: readonly JitMaterializationNeed[];
  exitMaterializations: readonly JitExitMaterializationPlan[];
  maxExitMaterializationIndex: number;
}>;
