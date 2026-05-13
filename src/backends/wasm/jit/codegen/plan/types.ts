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

export type JitStateSnapshot = JitBoundaryState;

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
  observedState: JitStateSnapshot;
  visibleEip: JitObservationValue;
  exitReason: ExitReasonValue;
  payload: JitObservationPayload;
  pathScope: JitMaterializationPathScope;
  /** Compatibility alias while older emission code still speaks in snapshots. */
  snapshot: JitStateSnapshot;
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
}>;

export type JitCodegenPlan = Readonly<{
  block: JitIrBlock;
  instructionStates: readonly JitInstructionState[];
  exitPoints: readonly JitExitPoint[];
  materializationNeeds: readonly JitMaterializationNeed[];
  exitMaterializations: readonly JitExitMaterializationPlan[];
  maxExitMaterializationIndex: number;
}>;

export function instructionEntry(instructionIndex: number): JitBoundaryRef {
  return { instructionIndex, boundaryIndex: 0 };
}

export function beforeOp(instructionIndex: number, opIndex: number): JitBoundaryRef {
  return { instructionIndex, boundaryIndex: opIndex };
}

export function afterOp(instructionIndex: number, opIndex: number): JitBoundaryRef {
  return { instructionIndex, boundaryIndex: opIndex + 1 };
}

export function instructionExit(
  instructionIndex: number,
  instruction: Readonly<{ ir: readonly unknown[] }>
): JitBoundaryRef {
  return { instructionIndex, boundaryIndex: instruction.ir.length };
}
