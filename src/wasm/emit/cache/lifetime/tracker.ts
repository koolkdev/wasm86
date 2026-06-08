import { assert } from "#common/assert.js";
import type { LayoutRegionId } from "#ir/block/planning/layout/index.js";
import type { WasmCacheEntryId } from "../plan/index.js";
import type {
  WasmCacheLifetimeLocalBorrow,
  WasmCacheLifetimePlan,
  WasmCacheLifetimeTracker,
  WasmCacheReleaseDecision
} from "./types.js";

type WasmCacheLifetimeBudgetState = {
  remainingUses: number;
  localBorrows: number;
  releasePending: boolean;
};

export const wasmCacheLifetimeKeepTracker: WasmCacheLifetimeTracker = {
  touchSelectedUse: () => keep(),
  borrowSelectedLocal: () => ({ release: () => keep() })
};

export function createWasmCacheLifetimeTracker(
  plan: WasmCacheLifetimePlan
): WasmCacheLifetimeTracker {
  const state = new WasmCacheLifetimeTrackerState(plan);

  return {
    touchSelectedUse: (input) => state.touchSelectedUse(input),
    borrowSelectedLocal: (input) => state.borrowSelectedLocal(input)
  };
}

class WasmCacheLifetimeTrackerState implements WasmCacheLifetimeTracker {
  readonly #byEntry = new Map<WasmCacheEntryId, Map<LayoutRegionId, WasmCacheLifetimeBudgetState>>();

  constructor(plan: WasmCacheLifetimePlan) {
    for (const budget of plan.budgets) {
      assert(budget.remainingUses > 0, "Wasm cache lifetime budgets must have at least one selected use");

      let byOwner = this.#byEntry.get(budget.entry);

      if (byOwner === undefined) {
        byOwner = new Map();
        this.#byEntry.set(budget.entry, byOwner);
      }

      assert(
        !byOwner.has(budget.ownerRegion),
        `duplicate Wasm cache lifetime budget for entry ${budget.entry} in region ${budget.ownerRegion}`
      );

      byOwner.set(budget.ownerRegion, {
        remainingUses: budget.remainingUses,
        localBorrows: 0,
        releasePending: false
      });
    }
  }

  touchSelectedUse(input: Parameters<WasmCacheLifetimeTracker["touchSelectedUse"]>[0]): WasmCacheReleaseDecision {
    const budget = this.#byEntry.get(input.entry)?.get(input.ownerRegion);

    if (budget === undefined || budget.remainingUses <= 0) {
      return keep();
    }

    budget.remainingUses -= 1;

    if (budget.remainingUses !== 0) {
      return keep();
    }

    if (budget.localBorrows > 0) {
      budget.releasePending = true;
      return keep();
    }

    return release();
  }

  borrowSelectedLocal(input: Parameters<WasmCacheLifetimeTracker["borrowSelectedLocal"]>[0]): WasmCacheLifetimeLocalBorrow {
    const budget = this.#byEntry.get(input.entry)?.get(input.ownerRegion);

    if (budget === undefined || budget.remainingUses <= 0) {
      return { release: () => keep() };
    }

    let released = false;

    budget.localBorrows += 1;
    budget.remainingUses -= 1;

    if (budget.remainingUses === 0) {
      budget.releasePending = true;
    }

    return {
      release: () => {
        assert(!released, `Wasm cache local borrow for entry ${input.entry} was released twice`);

        released = true;
        budget.localBorrows -= 1;

        if (budget.localBorrows === 0 && budget.releasePending) {
          budget.releasePending = false;
          return release();
        }

        return keep();
      }
    };
  }
}

function keep(): WasmCacheReleaseDecision {
  return { kind: "keep" };
}

function release(): WasmCacheReleaseDecision {
  return { kind: "release" };
}
