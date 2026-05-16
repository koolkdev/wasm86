import type {
  Exit,
  ExitSnapshot
} from "#backends/wasm/jit/analysis/exits.js";
import type { JitArchitecturalSlot, JitValue } from "#backends/wasm/jit/ir/values/types.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import {
  jitArchitecturalSlotsOverlap,
  jitRegisterSlotValueMask,
  slotsReadByValueForMask
} from "#backends/wasm/jit/ir/values/slots.js";
import {
  flagStoreSourceRequiredMask,
  flagStores
} from "./flag-stores.js";
import { registerStores } from "./register-stores.js";

export type ExitStore = Readonly<{
  target: JitArchitecturalSlot;
  value: JitValue;
}>;

export type ExitStoreSourceCapture = Readonly<{
  kind: "beforeStores";
  reason: "targetClobber";
}>;

export type PlannedExitStore = ExitStore & Readonly<{
  sourceCapture?: ExitStoreSourceCapture;
}>;

export type PlannedExit = Exit & Readonly<{
  stores: readonly ExitStore[];
  exitStoreIndex: number;
}>;

export type ExitStoreSet = Readonly<{
  stores: readonly PlannedExitStore[];
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

export function planExitStoreSourceCaptures(
  stores: readonly ExitStore[]
): readonly PlannedExitStore[] {
  const previousTargets: JitArchitecturalSlot[] = [];

  return stores.map((store) => {
    const planned = exitStoreSourceNeedsCapture(store, previousTargets)
      ? {
          ...store,
          sourceCapture: {
            kind: "beforeStores",
            reason: "targetClobber"
          }
        } satisfies PlannedExitStore
      : store;

    previousTargets.push(store.target);
    return planned;
  });
}

function appendExitStoreSet(
  exitStoreSets: ExitStoreSet[],
  stores: readonly ExitStore[]
): number {
  if (stores.length === 0) {
    return 0;
  }

  const index = exitStoreSets.length;

  exitStoreSets.push({ stores: planExitStoreSourceCaptures(stores) });
  return index;
}

function exitStoreSourceNeedsCapture(
  store: ExitStore,
  previousTargets: readonly JitArchitecturalSlot[]
): boolean {
  if (previousTargets.length === 0) {
    return false;
  }

  const simplified = simplifyValue(store.value);

  if (simplified.kind === "const") {
    return false;
  }

  const sourceSlots = slotsReadByValueForMask(simplified, exitStoreSourceRequiredMask(store.target));

  return previousTargets.some((target) =>
    sourceSlots.some((slot) => jitArchitecturalSlotsOverlap(slot, target))
  );
}

function exitStoreSourceRequiredMask(target: JitArchitecturalSlot): number {
  switch (target.kind) {
    case "reg8":
    case "reg16":
    case "reg32":
      return jitRegisterSlotValueMask(target);
    case "aluFlags":
      return flagStoreSourceRequiredMask(target);
  }
}
