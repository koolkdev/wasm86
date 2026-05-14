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
import type {
  JitControlPathScopesMap,
  JitValuePathScope
} from "./control-paths.js";

export type JitExitStateSnapshot = Readonly<{
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

export type JitObservationPoint = Readonly<{
  instructionIndex: number;
  opIndex: number;
  observedState: JitExitStateSnapshot;
  visibleEip: JitObservationValue;
  exitReason: ExitReasonValue;
  payload: JitObservationPayload;
  pathScope: JitValuePathScope;
  exitMaterializationIndex: number;
}>;

export type JitExitPoint = JitObservationPoint;

export type JitMaterializationPlacement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  observationIndex: number;
  exitPointIndex: number;
  exitReason: ExitReasonValue;
  exitMaterializationIndex: number;
}>;

export type JitExitStoreMaterializationNeed = Readonly<{
  purpose: "exitStore";
  target: MaterializationTarget;
  value: JitValue;
  placement: JitMaterializationPlacement;
  pathScope: JitValuePathScope;
}>;

export type JitMaterializationNeed = JitExitStoreMaterializationNeed;

export type JitExitMaterializationStore = ExitMaterializationStore;

export type JitInstructionState = Readonly<{
  instructionId: string;
  eip: number;
  nextEip: number;
  nextMode: "continue" | "exit";
  instructionCountDelta: number;
  initialValueState: JitValueStateSnapshot;
  controlPathScopes: JitControlPathScopesMap;
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
