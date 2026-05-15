import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { JitBlock } from "#backends/wasm/jit/ir/types.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
export type {
  ExitMaterializationStore,
  MaterializationTarget
} from "#backends/wasm/jit/ir/materialization.js";
import type {
  ExitMaterializationStore,
  MaterializationTarget
} from "#backends/wasm/jit/ir/materialization.js";
import type {
  Exit
} from "#backends/wasm/jit/analysis/exits.js";
import type {
  Effect
} from "#backends/wasm/jit/analysis/effects.js";
import type {
  Path,
  PathMap
} from "#backends/wasm/jit/analysis/paths.js";

export type {
  Exit,
  ExitPayload,
  ExitRuntimeSource,
  ExitSnapshot,
  ExitValue
} from "#backends/wasm/jit/analysis/exits.js";

export type PlannedExit = Exit & Readonly<{
  exitMaterializationIndex: number;
}>;

export type JitMaterializationPlacement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  exitIndex: number;
  exitId: string;
  reason: ExitReasonValue;
  exitMaterializationIndex: number;
}>;

export type JitExitStoreMaterializationNeed = Readonly<{
  purpose: "exitStore";
  target: MaterializationTarget;
  value: JitValue;
  placement: JitMaterializationPlacement;
  path: Path;
}>;

export type JitMaterializationNeed = JitExitStoreMaterializationNeed;

export type JitExitMaterializationStore = ExitMaterializationStore;

export type JitInstructionState = Readonly<{
  instructionId: string;
  eip: number;
  nextEip: number;
  nextMode: "continue" | "exit";
  instructionCountDelta: number;
  initialValueState: import("#backends/wasm/jit/state/value-state.js").JitValueStateSnapshot;
  paths: PathMap;
  exitCount: number;
}>;

export type JitExitMaterializationPlan = Readonly<{
  stores: readonly JitExitMaterializationStore[];
}>;

export type JitCodegenPlan = Readonly<{
  block: JitBlock;
  instructionStates: readonly JitInstructionState[];
  effects: readonly Effect<PlannedExit>[];
  exits: readonly PlannedExit[];
  materializationNeeds: readonly JitMaterializationNeed[];
  exitMaterializations: readonly JitExitMaterializationPlan[];
  maxExitMaterializationIndex: number;
}>;
