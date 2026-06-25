import { assert } from "#common/assert.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmModuleEncoder } from "#wasm/encoder/module.js";
import type { WasmFunctionType } from "#wasm/encoder/types.js";

export class HelperRegistry<TKey> {
  readonly #module: WasmModuleEncoder;
  readonly #typeIndex: number;
  readonly #keyId: (key: TKey) => string;
  readonly #entries = new Map<string, Readonly<{ key: TKey; functionIndex: number }>>();

  constructor(module: WasmModuleEncoder, type: WasmFunctionType, keyId: (key: TKey) => string) {
    this.#module = module;
    this.#typeIndex = module.addFunctionType(type);
    this.#keyId = keyId;
  }

  define(key: TKey, body: () => WasmFunctionBodyEncoder): number {
    const id = this.#keyId(key);
    const existing = this.#entries.get(id);

    if (existing !== undefined) {
      return existing.functionIndex;
    }

    const functionIndex = this.#module.addFunction(this.#typeIndex, body());

    this.#entries.set(id, { key, functionIndex });
    return functionIndex;
  }

  functionIndex(key: TKey): number | undefined {
    return this.#entries.get(this.#keyId(key))?.functionIndex;
  }

  requireFunctionIndex(key: TKey, displayName: string): number {
    const functionIndex = this.functionIndex(key);

    assert(functionIndex !== undefined, `missing Wasm helper ${displayName} in module registry`);
    return functionIndex;
  }

  has(key: TKey): boolean {
    return this.#entries.has(this.#keyId(key));
  }

  helpers(): readonly TKey[] {
    return [...this.#entries.values()].map((entry) => entry.key);
  }
}
