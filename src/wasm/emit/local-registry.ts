import { assert } from "#common/assert.js";
import type { ValueId } from "#ir/values.js";
import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import type { WasmValueType } from "#compiler/encoder/types.js";

// All scratch-local bookkeeping in one place. Counted compound captures and
// stable output bindings free their physical local after their final emitted
// use, deferred while pins hold them.

type TemporaryEntry = {
  kind: "temporary";
  local: number;
  remainingUses: number;
  pins: number;
};

type OutputEntry = {
  kind: "output";
  local: number | undefined;
  remainingUses: number;
  pins: number;
};

type RegistryEntry = TemporaryEntry | OutputEntry;

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
    this.#body.localSet(this.#captureTemporary(id, remainingUses, 0, type));
  }

  // Copies the stack top into a fresh local, leaving it pushed as one use.
  captureTee(id: ValueId, remainingUses: number, type: WasmValueType): void {
    this.#body.localTee(this.#captureTemporary(id, remainingUses, 0, type));
  }

  // Copies the stack top into a fresh local held only by a pin.
  capturePinned(id: ValueId, type: WasmValueType): void {
    this.#body.localTee(this.#captureTemporary(id, 0, 1, type));
  }

  // Claims an output local the caller stores into itself. Each selected arm
  // writes a control join's output local.
  claimOutputLocal(id: ValueId, remainingUses: number, type: WasmValueType): number {
    const local = this.#allocLocal(id, remainingUses, 0, type);

    this.#entries.set(id, { kind: "output", local, remainingUses, pins: 0 });
    return local;
  }

  replay(id: ValueId): boolean {
    const entry = this.#entries.get(id);

    if (entry === undefined) {
      return false;
    }

    const local = entry.local;

    assert(local !== undefined, `value ${id} has no emitted uses remaining`);
    assert(entry.remainingUses > 0, `value ${id} has no emitted uses remaining`);
    this.#body.localGet(local);
    entry.remainingUses -= 1;
    this.#maybeFree(id, entry);
    return true;
  }

  // Replays without consuming a counted use; only sound under a pin.
  peek(id: ValueId): void {
    const entry = this.#entries.get(id);

    assert(entry !== undefined, `value ${id} is not captured`);
    const local = entry.local;

    assert(local !== undefined, `value ${id} has no physical local`);
    assert(entry.pins > 0, `value ${id} is not pinned`);
    this.#body.localGet(local);
  }

  // Pins keep an entry alive past its last counted use until unpinned.
  pin(id: ValueId): void {
    const entry = this.#entries.get(id);

    assert(entry !== undefined, `value ${id} is not captured`);
    assert(entry.local !== undefined, `value ${id} has no physical local`);
    entry.pins += 1;
  }

  unpin(id: ValueId): void {
    const entry = this.#entries.get(id);

    assert(entry !== undefined, `value ${id} is not captured`);
    assert(entry.pins > 0, `value ${id} is not pinned`);
    entry.pins -= 1;
    this.#maybeFree(id, entry);
  }

  has(id: ValueId): boolean {
    return this.#entries.has(id);
  }

  releaseOutputBindings(): void {
    for (const [id, entry] of this.#entries) {
      if (entry.kind !== "output") {
        continue;
      }

      assert(entry.remainingUses === 0, `output binding ${id} has unconsumed emitted uses`);
      assert(entry.pins === 0, `output binding ${id} is still pinned`);
      assert(entry.local === undefined, `output binding ${id} still owns a physical local`);
      this.#entries.delete(id);
    }
  }

  assertClear(): void {
    assert(
      this.#entries.size === 0,
      `value bindings never released: ${[...this.#entries.keys()].join(", ")}`
    );
  }

  #captureTemporary(
    id: ValueId,
    remainingUses: number,
    pins: number,
    type: WasmValueType
  ): number {
    const local = this.#allocLocal(id, remainingUses, pins, type);

    this.#entries.set(id, { kind: "temporary", local, remainingUses, pins });
    return local;
  }

  #allocLocal(
    id: ValueId,
    remainingUses: number,
    pins: number,
    type: WasmValueType
  ): number {
    assert(remainingUses > 0 || pins > 0, `cannot capture value ${id} without uses or pins`);
    assert(!this.#entries.has(id), `value ${id} is already captured`);
    return this.#scratch.allocLocal(type);
  }

  #maybeFree(id: ValueId, entry: RegistryEntry): void {
    if (entry.remainingUses === 0 && entry.pins === 0) {
      const local = entry.local;

      assert(local !== undefined, `value ${id} has no physical local to release`);
      this.#scratch.freeLocal(local);

      if (entry.kind === "output") {
        entry.local = undefined;
      } else {
        this.#entries.delete(id);
      }
    }
  }
}
