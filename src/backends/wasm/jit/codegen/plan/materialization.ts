import type {
  ExitMaterializationStore,
  JitExitPoint,
  JitMaterializationNeed
} from "./types.js";

export function jitMaterializationNeedsForExitStores(
  exitPoint: JitExitPoint,
  exitPointIndex: number,
  stores: readonly ExitMaterializationStore[]
): readonly JitMaterializationNeed[] {
  const placement = {
    instructionIndex: exitPoint.instructionIndex,
    opIndex: exitPoint.opIndex,
    observationIndex: exitPointIndex,
    exitPointIndex,
    exitReason: exitPoint.exitReason,
    exitMaterializationIndex: exitPoint.exitMaterializationIndex
  };

  return stores.map((store) => ({
    purpose: "exitStore",
    target: store.target,
    value: store.value,
    placement,
    pathScope: exitPoint.pathScope
  }));
}
