import { assert } from "#common/assert.js";
import { helperFunctionName, type HelperCallKey } from "./key.js";

export type LegacyHelperIndexBinding = Readonly<{
  key: HelperCallKey;
  functionIndex: number;
}>;

// Numeric compatibility for emitters that still lower helper calls directly
// to Wasm indexes. Helper definitions, body factories, and reachability are
// deliberately owned by the caller that constructs these resolved bindings.
export class LegacyHelperIndexRegistryAdapter {
  readonly #functionIndices = new Map<string, number>();

  constructor(bindings: Iterable<LegacyHelperIndexBinding>) {
    for (const binding of bindings) {
      const id = helperFunctionName(binding.key);

      assert(!this.#functionIndices.has(id), `duplicate Wasm helper index binding: ${id}`);
      assert(
        Number.isInteger(binding.functionIndex) && binding.functionIndex >= 0,
        `invalid Wasm helper function index for ${id}: ${binding.functionIndex}`
      );
      this.#functionIndices.set(id, binding.functionIndex);
    }
  }

  functionIndex(key: HelperCallKey): number | undefined {
    return this.#functionIndices.get(helperFunctionName(key));
  }
}
