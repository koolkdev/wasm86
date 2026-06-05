import { selectCacheEntries } from "./selection.js";
import type {
  MutableEntry,
  WasmCacheEntry,
  WasmCachePlan,
  WasmCachePlanInput
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

    return freezePlan(selected.entries);
  }
}

function freezePlan(entries: readonly MutableEntry[]): WasmCachePlan {
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze({
      id: entry.id,
      recipe: entry.recipe,
      reasons: Object.freeze([...entry.reasons]),
      uses: Object.freeze([...entry.uses])
    } satisfies WasmCacheEntry)))
  } satisfies WasmCachePlan);
}
