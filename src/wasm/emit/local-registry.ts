import { assert } from "#common/assert.js";
import type { ValueId } from "#ir/values.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmValueType } from "#wasm/encoder/types.js";

// All scratch-local bookkeeping in one place. Counted compound captures free
// at their last use (deferred while pins hold them); action and switch output
// locals remain bound until the fragment releases them.

type RegistryEntry = {
  local: number;
  // Undefined marks a fragment-owned output binding.
  remainingUses: number | undefined;
  pins: number;
};

export class LocalRegistry {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #scratch: WasmLocalScratchAllocator;
  readonly #entries = new Map<ValueId, RegistryEntry>();

  constructor(body: WasmFunctionBodyEncoder, scratch: WasmLocalScratchAllocator) {
    this.#body = body;
    this.#scratch = scratch;
  }

  // Pops the stack top into a fresh local.
  captureSet(id: ValueId, remainingUses: number, type: WasmValueType): void {
    this.#body.localSet(this.#capture(id, remainingUses, 0, type));
  }

  // Copies the stack top into a fresh local, leaving it pushed as one use.
  captureTee(id: ValueId, remainingUses: number, type: WasmValueType): void {
    this.#body.localTee(this.#capture(id, remainingUses, 0, type));
  }

  // Copies the stack top into a fresh local held only by a pin.
  capturePinned(id: ValueId, type: WasmValueType): void {
    this.#body.localTee(this.#capture(id, 0, 1, type));
  }

  // Pops the stack top into a fragment-owned output local.
  captureOutputSet(id: ValueId, type: WasmValueType): void {
    this.#body.localSet(this.claimOutputLocal(id, type));
  }

  // Claims an output local the caller stores into itself. Each selected arm
  // writes a control join's output local.
  claimOutputLocal(id: ValueId, type: WasmValueType): number {
    assert(!this.#entries.has(id), `value ${id} is already captured`);

    const local = this.#scratch.allocLocal(type);

    this.#entries.set(id, { local, remainingUses: undefined, pins: 0 });
    return local;
  }

  replay(id: ValueId): boolean {
    const entry = this.#entries.get(id);

    if (entry === undefined) {
      return false;
    }

    this.#body.localGet(entry.local);

    if (entry.remainingUses !== undefined) {
      assert(entry.remainingUses > 0, `no counted uses of value ${id} remain`);
      entry.remainingUses -= 1;
      this.#maybeFree(id, entry);
    }
    return true;
  }

  // Replays without consuming a counted use; only sound under a pin.
  peek(id: ValueId): void {
    this.#body.localGet(this.#entry(id).local);
  }

  // Pins keep an entry alive past its last counted use until unpinned.
  pin(id: ValueId): void {
    this.#entry(id).pins += 1;
  }

  unpin(id: ValueId): void {
    const entry = this.#entry(id);

    assert(entry.pins > 0, `value ${id} is not pinned`);
    entry.pins -= 1;
    this.#maybeFree(id, entry);
  }

  has(id: ValueId): boolean {
    return this.#entries.has(id);
  }

  releaseOutputLocals(): void {
    for (const [id, entry] of this.#entries) {
      if (entry.remainingUses !== undefined) {
        continue;
      }

      assert(entry.pins === 0, `output local ${id} is still pinned`);
      this.#entries.delete(id);
      this.#scratch.freeLocal(entry.local);
    }
  }

  assertClear(): void {
    assert(
      this.#entries.size === 0,
      `captured values with unconsumed uses: ${[...this.#entries.keys()].join(", ")}`
    );
  }

  #capture(id: ValueId, remainingUses: number, pins: number, type: WasmValueType): number {
    assert(remainingUses > 0 || pins > 0, `cannot capture value ${id} without uses or pins`);
    assert(!this.#entries.has(id), `value ${id} is already captured`);

    const local = this.#scratch.allocLocal(type);

    this.#entries.set(id, { local, remainingUses, pins });
    return local;
  }

  #entry(id: ValueId): RegistryEntry {
    const entry = this.#entries.get(id);

    assert(entry !== undefined, `value ${id} is not captured`);
    return entry;
  }

  #maybeFree(id: ValueId, entry: RegistryEntry): void {
    if (entry.remainingUses === 0 && entry.pins === 0) {
      this.#entries.delete(id);
      this.#scratch.freeLocal(entry.local);
    }
  }
}
