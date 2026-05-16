import type {
  Exit,
  ExitSnapshot
} from "#backends/wasm/jit/analysis/exits.js";
import type { JitArchitecturalSlot, JitValue } from "#backends/wasm/jit/ir/values/types.js";
import { flagStores } from "./flag-stores.js";
import { registerStores } from "./register-stores.js";

export type ExitStore = Readonly<{
  target: JitArchitecturalSlot;
  value: JitValue;
}>;

export type PlannedExit = Exit & Readonly<{
  stores: readonly ExitStore[];
  exitStoreIndex: number;
}>;

export type ExitStoreSet = Readonly<{
  stores: readonly ExitStore[];
}>;

export type ExitStorePlan = Readonly<{
  exits: readonly PlannedExit[];
  exitStoreSets: readonly ExitStoreSet[];
  maxExitStoreIndex: number;
}>;

export function planExitStores(exits: readonly Exit[]): ExitStorePlan {
  const plannedExits: PlannedExit[] = [];
  const exitStoreSets: ExitStoreSet[] = [{ stores: [] }];

  for (const exit of exits) {
    const stores = storesForExit(exit);
    const exitStoreIndex = appendExitStoreSet(exitStoreSets, stores);

    plannedExits.push({
      ...exit,
      stores,
      exitStoreIndex
    });
  }

  return {
    exits: plannedExits,
    exitStoreSets,
    maxExitStoreIndex: exitStoreSets.length - 1
  };
}

export function storesForExit(exit: Exit): readonly ExitStore[] {
  return storesForSnapshot(exit.snapshot);
}

export function storesForSnapshot(snapshot: ExitSnapshot): readonly ExitStore[] {
  return [
    ...registerStores(snapshot.valueState),
    ...flagStores(snapshot.valueState)
  ];
}

function appendExitStoreSet(
  exitStoreSets: ExitStoreSet[],
  stores: readonly ExitStore[]
): number {
  if (stores.length === 0) {
    return 0;
  }

  const index = exitStoreSets.length;

  exitStoreSets.push({ stores });
  return index;
}
