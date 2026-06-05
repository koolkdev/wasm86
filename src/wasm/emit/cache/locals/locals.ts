import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmValueType } from "#wasm/encoder/types.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId
} from "../plan/index.js";
import type {
  WasmCacheActiveRegion,
  WasmCacheVisibleRegions
} from "./regions.js";

export type WasmCachedLocal = {
  entry: WasmCacheEntry;
  local: number;
  type: WasmValueType;
  owner: WasmCacheActiveRegion;
};

export class WasmValueCacheLocals {
  readonly #scratch: WasmLocalScratchAllocator;
  readonly #byEntry = new Map<WasmCacheEntryId, WasmCachedLocal[]>();

  constructor(scratch: WasmLocalScratchAllocator) {
    this.#scratch = scratch;
  }

  get(entry: WasmCacheEntryId, visibleRegions: WasmCacheVisibleRegions): WasmCachedLocal | undefined {
    const locals = this.#byEntry.get(entry);

    if (locals === undefined) {
      return undefined;
    }

    for (const owner of visibleRegions) {
      const local = locals.find((candidate) => candidate.owner === owner);

      if (local !== undefined) {
        return local;
      }
    }

    return undefined;
  }

  establish(entry: WasmCacheEntry, type: WasmValueType, owner: WasmCacheActiveRegion): WasmCachedLocal {
    const visible = this.#getOwned(entry.id, owner);

    if (visible !== undefined) {
      return visible;
    }

    const local = {
      entry,
      local: this.#scratch.allocLocal(type),
      type,
      owner
    };

    const locals = this.#byEntry.get(entry.id) ?? [];

    locals.push(local);
    this.#byEntry.set(entry.id, locals);
    return local;
  }

  #getOwned(entry: WasmCacheEntryId, owner: WasmCacheActiveRegion): WasmCachedLocal | undefined {
    return this.#byEntry.get(entry)?.find((local) => local.owner === owner);
  }

  releaseEntry(entry: WasmCacheEntryId, owner: WasmCacheActiveRegion): void {
    const locals = this.#byEntry.get(entry);
    const index = locals?.findIndex((local) => local.owner === owner) ?? -1;

    if (locals === undefined || index < 0) {
      return;
    }

    const [local] = locals.splice(index, 1);

    if (locals.length === 0) {
      this.#byEntry.delete(entry);
    }

    if (local === undefined) {
      return;
    }

    this.#scratch.freeLocal(local.local);
  }

  releaseOwnedBy(owner: WasmCacheActiveRegion): void {
    for (const locals of [...this.#byEntry.values()]) {
      for (const local of [...locals]) {
        if (local.owner === owner) {
          this.releaseEntry(local.entry.id, owner);
        }
      }
    }
  }
}
