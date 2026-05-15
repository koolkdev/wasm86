import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import type {
  ExitMaterializationStore,
  JitExitMaterializationPlan,
  JitMaterializationNeed,
  PlannedExit
} from "./types.js";

export type JitExitStorePlan = Readonly<{
  exits: readonly PlannedExit[];
  materializationNeeds: readonly JitMaterializationNeed[];
  exitMaterializations: readonly JitExitMaterializationPlan[];
  maxExitMaterializationIndex: number;
}>;

export function planJitExitStores(
  exits: readonly Exit[]
): JitExitStorePlan {
  const plannedExits: PlannedExit[] = [];
  const materializationNeeds: JitMaterializationNeed[] = [];
  const exitMaterializations: JitExitMaterializationPlan[] = [{ stores: [] }];

  for (const exit of exits) {
    const stores = exit.snapshot.valueState.exitStores();
    const exitMaterializationIndex = appendExitMaterialization(exitMaterializations, stores);
    const plannedExit: PlannedExit = {
      ...exit,
      exitMaterializationIndex
    };
    const exitIndex = plannedExits.length;

    plannedExits.push(plannedExit);
    materializationNeeds.push(...materializationNeedsForExitStores(
      plannedExit,
      exitIndex,
      stores
    ));
  }

  return {
    exits: plannedExits,
    materializationNeeds,
    exitMaterializations,
    maxExitMaterializationIndex: exitMaterializations.length - 1
  };
}

function materializationNeedsForExitStores(
  exit: PlannedExit,
  exitIndex: number,
  stores: readonly ExitMaterializationStore[]
): readonly JitMaterializationNeed[] {
  const placement = {
    instructionIndex: exit.at.instructionIndex,
    opIndex: exit.at.opIndex,
    exitIndex,
    exitId: exit.id,
    reason: exit.reason,
    exitMaterializationIndex: exit.exitMaterializationIndex
  };

  return stores.map((store) => ({
    purpose: "exitStore",
    target: store.target,
    value: store.value,
    placement,
    path: exit.path
  }));
}

function appendExitMaterialization(
  exitMaterializations: JitExitMaterializationPlan[],
  stores: readonly ExitMaterializationStore[]
): number {
  if (stores.length === 0) {
    return 0;
  }

  const index = exitMaterializations.length;

  exitMaterializations.push({
    stores
  });
  return index;
}
