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
    emitBoundary: exitPoint.emitBoundary,
    observedBoundary: exitPoint.observedBoundary,
    observationIndex: exitPointIndex,
    exitPointIndex,
    exitReason: exitPoint.exitReason,
    exitMaterializationIndex: exitPoint.exitMaterializationIndex
  };

  return stores.map((store) => ({
    consumer: store.target.kind === "aluFlags" ? "flagExitStore" : "registerExitStore",
    target: store.target,
    value: store.value,
    placement,
    pathScope: exitPoint.pathScope
  }));
}
