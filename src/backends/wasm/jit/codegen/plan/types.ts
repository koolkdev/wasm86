import type { JitBlock } from "#backends/wasm/jit/ir/types.js";
import type {
  Effect
} from "#backends/wasm/jit/analysis/effects.js";
import type {
  PathMap
} from "#backends/wasm/jit/analysis/paths.js";
import type {
  ExitStoreSet,
  PlannedExit
} from "./exit-stores.js";

export type {
  Exit,
  ExitPayload,
  ExitRuntimeSource,
  ExitSnapshot,
  ExitValue
} from "#backends/wasm/jit/analysis/exits.js";
export type {
  ExitStore,
  ExitStoreSourceCapture,
  ExitStorePlan,
  ExitStoreSet,
  PlannedExitStore,
  PlannedExit
} from "./exit-stores.js";

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

export type JitCodegenPlan = Readonly<{
  block: JitBlock;
  instructionStates: readonly JitInstructionState[];
  effects: readonly Effect<PlannedExit>[];
  exits: readonly PlannedExit[];
  exitStoreSets: readonly ExitStoreSet[];
  maxExitStoreIndex: number;
}>;
