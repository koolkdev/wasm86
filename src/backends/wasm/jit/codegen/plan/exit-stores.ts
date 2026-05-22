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

export type ExitStorePlan = Readonly<{
  exits: ReadonlyMap<string, PlannedExit>;
}>;

export function planExitStores(analyzedExits: readonly Exit[]): ExitStorePlan {
  const exits = new Map<string, PlannedExit>();
  let nextExitStoreIndex = 1;

  for (const exit of analyzedExits) {
    const stores = storesForExit(exit);
    const exitStoreIndex = stores.length === 0
      ? 0
      : nextExitStoreIndex++;
    const plannedExit: PlannedExit = {
      ...exit,
      stores,
      exitStoreIndex
    };

    if (exits.has(plannedExit.id)) {
      throw new Error(`duplicate planned JIT exit id: ${plannedExit.id}`);
    }

    exits.set(plannedExit.id, plannedExit);
  }

  return {
    exits
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
