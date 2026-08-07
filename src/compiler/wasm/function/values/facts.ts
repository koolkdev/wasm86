import { assert } from "#common/assert.js";
import type { WasmValueId } from "./nodes.js";

const instructionCanSpeculateMask = 1;
const recipeCanSpeculateMask = 2;
const loopDepthShift = 2;

export class WasmValueFacts {
  readonly #entries: Uint32Array;

  constructor(entries: readonly number[]) {
    this.#entries = Uint32Array.from(entries);
  }

  get length(): number {
    return this.#entries.length;
  }

  instructionCanSpeculate(id: WasmValueId): boolean {
    return (this.#entry(id) & instructionCanSpeculateMask) !== 0;
  }

  recipeCanSpeculate(id: WasmValueId): boolean {
    return (this.#entry(id) & recipeCanSpeculateMask) !== 0;
  }

  requiredLoopDepth(id: WasmValueId): number {
    return this.#entry(id) >>> loopDepthShift;
  }

  #entry(id: WasmValueId): number {
    const entry = this.#entries[id];

    assert(entry !== undefined, `unknown Wasm value ${id}`);
    return entry;
  }
}

export function packWasmValueFacts(
  instructionCanSpeculate: boolean,
  recipeCanSpeculate: boolean,
  requiredLoopDepth: number
): number {
  return (
    (requiredLoopDepth * 2 ** loopDepthShift) |
    (instructionCanSpeculate ? instructionCanSpeculateMask : 0) |
    (recipeCanSpeculate ? recipeCanSpeculateMask : 0)
  );
}
