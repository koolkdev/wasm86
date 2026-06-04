import { scheduleCacheOccurrences } from "./schedule.js";
import { selectCacheEntries } from "./selection.js";
import type {
  MutableEntry,
  MutableRegionSchedule,
  WasmCacheEntry,
  WasmCachePlan,
  WasmCachePlanInput,
  WasmCacheRegionSchedule
} from "./types.js";

export function planWasmCache(input: WasmCachePlanInput): WasmCachePlan {
  return new WasmCachePlanner(input).plan();
}

export class WasmCachePlanner {
  readonly #input: WasmCachePlanInput;
  #plan: WasmCachePlan | undefined;

  constructor(input: WasmCachePlanInput) {
    this.#input = input;
  }

  plan(): WasmCachePlan {
    if (this.#plan === undefined) {
      this.#plan = this.#build();
    }

    return this.#plan;
  }

  #build(): WasmCachePlan {
    const selected = selectCacheEntries(this.#input);
    const schedule = scheduleCacheOccurrences({
      layout: this.#input.layout,
      recipes: this.#input.values.recipes,
      selected
    });

    return freezePlan(selected.entries, schedule);
  }
}

function freezePlan(
  entries: readonly MutableEntry[],
  schedule: readonly MutableRegionSchedule[]
): WasmCachePlan {
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze({
      id: entry.id,
      recipe: entry.recipe,
      reasons: Object.freeze([...entry.reasons]),
      uses: Object.freeze([...entry.uses])
    } satisfies WasmCacheEntry))),
    schedule: Object.freeze(schedule.map((regionSchedule) => Object.freeze({
      region: regionSchedule.region,
      occurrences: Object.freeze([...regionSchedule.occurrences])
    } satisfies WasmCacheRegionSchedule)))
  } satisfies WasmCachePlan);
}
