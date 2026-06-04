import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmValueType } from "#wasm/encoder/types.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId
} from "../plan/index.js";
import type { WasmCacheActiveRegion } from "./cursor.js";

export type WasmCachedLocal = {
  entry: WasmCacheEntry;
  local: number;
  type: WasmValueType;
  owner: WasmCacheActiveRegion;
};

export class WasmValueCacheLocals {
  readonly #scratch: WasmLocalScratchAllocator;
  readonly #byEntry = new Map<WasmCacheEntryId, WasmCachedLocal>();

  constructor(scratch: WasmLocalScratchAllocator) {
    this.#scratch = scratch;
  }

  get(entry: WasmCacheEntryId): WasmCachedLocal | undefined {
    return this.#byEntry.get(entry);
  }

  establish(entry: WasmCacheEntry, type: WasmValueType, owner: WasmCacheActiveRegion): WasmCachedLocal {
    const visible = this.#byEntry.get(entry.id);

    if (visible !== undefined) {
      return visible;
    }

    const local = {
      entry,
      local: this.#scratch.allocLocal(type),
      type,
      owner
    };

    this.#byEntry.set(entry.id, local);
    return local;
  }

  releaseEntry(entry: WasmCacheEntryId): void {
    const local = this.#byEntry.get(entry);

    if (local === undefined) {
      return;
    }

    this.#byEntry.delete(entry);
    this.#scratch.freeLocal(local.local);
  }

  releaseOwnedBy(owner: WasmCacheActiveRegion): void {
    for (const local of [...this.#byEntry.values()]) {
      if (local.owner === owner) {
        this.releaseEntry(local.entry.id);
      }
    }
  }
}
