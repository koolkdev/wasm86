import { pathsEqual } from "#backends/wasm/jit/analysis/paths.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import {
  jitArchitecturalSlotsOverlap,
  jitRegisterSlotValueMask,
  slotsReadByValueForMask
} from "#backends/wasm/jit/ir/values/slots.js";
import type {
  JitArchitecturalSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type {
  Capture,
  CapturePlan
} from "./captures.js";
import type {
  ExitStore,
  PlannedExit
} from "./exit-stores.js";
import { flagStoreSourceRequiredMask } from "./flag-stores.js";

export type StoreStrategyInput = Readonly<{
  exits: readonly PlannedExit[];
  captures: CapturePlan;
}>;

export type StoreStrategyPlan = Readonly<{
  exits: readonly PlannedExitStores[];
  exitStoreSets: readonly StoreStrategySet[];
  maxExitStoreIndex: number;
}>;

export type PlannedExitStores = Readonly<{
  exit: PlannedExit;
  stores: readonly PlannedExitStore[];
}>;

export type StoreStrategySet = Readonly<{
  stores: readonly PlannedExitStore[];
}>;

export type PlannedExitStore = Readonly<{
  store: ExitStore;
  source: StoreSourceStrategy;
}>;

export type StoreSourceStrategy =
  | Readonly<{ kind: "inline" }>
  | Readonly<{ kind: "capture"; capture: Capture }>;

export function planStoreStrategy(input: StoreStrategyInput): StoreStrategyPlan {
  const maxExitStoreIndex = maxExitStoreIndexFor(input.exits);
  const exitStoreSets: StoreStrategySet[] = Array.from(
    { length: maxExitStoreIndex + 1 },
    () => ({ stores: [] })
  );
  const exits = input.exits.map((exit) => {
    const stores = planStoresForExit(exit, input.captures);

    exitStoreSets[exit.exitStoreIndex] = { stores };
    return { exit, stores };
  });

  return {
    exits,
    exitStoreSets,
    maxExitStoreIndex
  };
}

export function storeClobberSourceStores(exit: PlannedExit): readonly ExitStore[] {
  const previousTargets: JitArchitecturalSlot[] = [];
  const stores: ExitStore[] = [];

  for (const store of exit.stores) {
    if (sourceNeedsCapture(store, previousTargets)) {
      stores.push(store);
    }

    previousTargets.push(store.target);
  }

  return stores;
}

export function storeClobberValues(exits: readonly PlannedExit[]): readonly JitValue[] {
  const values: JitValue[] = [];

  for (const exit of exits) {
    for (const store of storeClobberSourceStores(exit)) {
      if (!values.some((value) => valuesEqual(value, store.value))) {
        values.push(store.value);
      }
    }
  }

  return values;
}

export function sourceNeedsCapture(
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

  const sourceSlots = slotsReadByValueForMask(
    simplified,
    storeSourceRequiredMask(store.target)
  );

  return previousTargets.some((target) =>
    sourceSlots.some((slot) => jitArchitecturalSlotsOverlap(slot, target))
  );
}

function planStoresForExit(
  exit: PlannedExit,
  captures: CapturePlan
): readonly PlannedExitStore[] {
  const previousTargets: JitArchitecturalSlot[] = [];
  const stores: PlannedExitStore[] = [];

  for (const store of exit.stores) {
    const source = sourceNeedsCapture(store, previousTargets)
      ? {
          kind: "capture",
          capture: requiredStoreClobberCapture(captures, exit, store)
        } satisfies StoreSourceStrategy
      : { kind: "inline" } satisfies StoreSourceStrategy;

    stores.push({ store, source });
    previousTargets.push(store.target);
  }

  return stores;
}

function requiredStoreClobberCapture(
  captures: CapturePlan,
  exit: PlannedExit,
  store: ExitStore
): Capture {
  const capture = captures.captures.find((candidate) =>
    candidate.reason === "storeClobber" &&
      pathsEqual(candidate.availability, exit.path) &&
      valuesEqual(candidate.value, store.value) &&
      candidate.consumers.some((consumer) =>
        consumer.exitId === exit.id &&
          valuesEqual(consumer.value, store.value)
      )
  );

  if (capture === undefined) {
    throw new Error(`missing JIT store-clobber capture for exit ${exit.id}`);
  }

  return capture;
}

function maxExitStoreIndexFor(exits: readonly PlannedExit[]): number {
  return exits.reduce(
    (max, exit) => Math.max(max, exit.exitStoreIndex),
    0
  );
}

function storeSourceRequiredMask(target: JitArchitecturalSlot): number {
  switch (target.kind) {
    case "reg8":
    case "reg16":
    case "reg32":
      return jitRegisterSlotValueMask(target);
    case "aluFlags":
      return flagStoreSourceRequiredMask(target);
  }
}
