import type { LayoutRegion } from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ValueSnapshotId
} from "#ir/block/planning/values/index.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { WasmCacheEntryIndex } from "./entries.js";
import { WasmValueCacheLocals } from "./locals.js";
import { WasmCacheRegionStack } from "./regions.js";
import type {
  WasmValueCache,
  WasmValueCacheInlineEmitter,
  WasmValueCacheInput,
  WasmValueCacheUse
} from "./types.js";

export function createWasmValueCache(input: WasmValueCacheInput): WasmValueCache {
  return new WasmValueCacheState(input);
}

export class WasmValueCacheState implements WasmValueCache {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #entries: WasmCacheEntryIndex;
  readonly #regions = new WasmCacheRegionStack();
  readonly #locals: WasmValueCacheLocals;

  constructor(input: WasmValueCacheInput) {
    this.#body = input.body;
    this.#entries = new WasmCacheEntryIndex(input.plan, input.values);
    this.#locals = new WasmValueCacheLocals(input.scratch ?? new WasmLocalScratchAllocator(input.body));
  }

  enterRegion(region: LayoutRegion): void {
    this.#regions.enterRegion(region);
  }

  leaveRegion(region: LayoutRegion): void {
    const active = this.#regions.leaveRegion(region);

    this.#locals.releaseOwnedBy(active);
  }

  emitUse(use: WasmValueCacheUse, emitInline: WasmValueCacheInlineEmitter): ReturnType<WasmValueCache["emitUse"]> {
    return this.emitRecipe(use.recipe, emitInline);
  }

  emitRecipe(
    recipe: ExprRecipe,
    emitInline: WasmValueCacheInlineEmitter
  ): ReturnType<WasmValueCache["emitRecipe"]> {
    if (recipe.kind === "snapshot") {
      return this.emitSnapshot(recipe.snapshot);
    }

    const entry = this.#entries.entryForRecipe(recipe);

    if (entry === undefined) {
      return emitInline();
    }

    const active = this.#regions.activeRegion();
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    if (visible !== undefined) {
      this.#body.localGet(visible.local);
      return visible.type;
    }

    const type = emitInline();
    const local = this.#locals.establish(entry, type, active);

    this.#body.localTee(local.local);
    return type;
  }

  ensureSnapshot(snapshot: ValueSnapshotId, recipe: ExprRecipe, emitInline: WasmValueCacheInlineEmitter): void {
    const entry = this.#entries.entryForSnapshot(snapshot);
    const active = this.#regions.activeRegion();
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    this.#entries.assertSameRecipe(recipe, entry.recipe);

    if (visible !== undefined) {
      return;
    }

    const type = emitInline();
    const local = this.#locals.establish(entry, type, active);

    this.#body.localSet(local.local);
  }

  emitSnapshot(snapshot: ValueSnapshotId): ReturnType<WasmValueCache["emitSnapshot"]> {
    const entry = this.#entries.entryForSnapshot(snapshot);
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    if (visible === undefined) {
      throw new Error(`snapshot expression ${snapshot} is not available in the active Wasm cache path`);
    }

    this.#body.localGet(visible.local);
    return visible.type;
  }
}
