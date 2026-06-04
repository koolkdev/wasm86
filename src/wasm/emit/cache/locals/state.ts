import type { LayoutRegion } from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  SavedExprId
} from "#ir/block/planning/values/index.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId,
  WasmCacheOccurrenceSource,
  WasmCacheRecipeOccurrence,
  WasmCacheSavedExprOccurrence,
  WasmCacheSaveExprOccurrence
} from "../plan/index.js";
import { WasmCacheEntryIndex } from "./entries.js";
import { WasmValueCacheLocals } from "./locals.js";
import {
  describeOccurrence,
  occurrenceHasSaveExprSource,
  sameSource,
  WasmCacheScheduleCursor
} from "./cursor.js";
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
  readonly #schedule: WasmCacheScheduleCursor;
  readonly #locals: WasmValueCacheLocals;

  constructor(input: WasmValueCacheInput) {
    this.#body = input.body;
    this.#entries = new WasmCacheEntryIndex(input.plan, input.values);
    this.#schedule = new WasmCacheScheduleCursor(input.plan);
    this.#locals = new WasmValueCacheLocals(input.scratch ?? new WasmLocalScratchAllocator(input.body));
  }

  enterRegion(region: LayoutRegion): void {
    this.#schedule.enterRegion(region);
  }

  leaveRegion(region: LayoutRegion): void {
    const active = this.#schedule.activeRegion();

    if (active.region.id !== region.id) {
      throw new Error(`cannot leave Wasm cache region ${region.id}; active region is ${active.region.id}`);
    }

    this.#schedule.assertActiveComplete();
    this.#locals.releaseOwnedBy(active);
    this.#schedule.leaveRegion(region);
  }

  emitUse(use: WasmValueCacheUse, emitInline: WasmValueCacheInlineEmitter): ReturnType<WasmValueCache["emitUse"]> {
    return this.emitRecipe(use.recipe, Object.freeze({
      kind: "layout-use",
      use: use.id
    } satisfies WasmCacheOccurrenceSource), emitInline);
  }

  emitRecipe(
    recipe: ExprRecipe,
    source: WasmCacheOccurrenceSource,
    emitInline: WasmValueCacheInlineEmitter
  ): ReturnType<WasmValueCache["emitRecipe"]> {
    if (recipe.kind === "saved-expr") {
      return this.emitSaved(recipe.saved, source);
    }

    const entry = this.#entries.entryForRecipe(recipe);

    if (entry === undefined) {
      return emitInline();
    }

    const visible = this.#locals.get(entry.id);

    if (visible !== undefined) {
      this.#consumeRecipeOccurrence(entry, recipe, source);
      this.#body.localGet(visible.local);
      this.#releaseIfComplete(entry.id);
      return visible.type;
    }

    const type = emitInline();
    this.#consumeRecipeOccurrence(entry, recipe, source);
    const local = this.#locals.establish(entry, type, this.#schedule.activeRegion());

    this.#body.localTee(local.local);
    this.#releaseIfComplete(entry.id);
    return type;
  }

  ensureSaved(saved: SavedExprId, recipe: ExprRecipe, emitInline: WasmValueCacheInlineEmitter): void {
    const entry = this.#entries.entryForSaved(saved);
    const visible = this.#locals.get(entry.id);

    if (visible !== undefined) {
      this.#skipSaveExprInline(saved);
      this.#consumeSaveExprOccurrence(entry, saved, recipe);
      this.#releaseIfComplete(entry.id);
      return;
    }

    this.#assertSaveExprInlineCanStart(saved);

    const type = emitInline();

    this.#consumeSaveExprOccurrence(entry, saved, recipe);

    const local = this.#locals.establish(entry, type, this.#schedule.activeRegion());

    this.#body.localSet(local.local);
    this.#releaseIfComplete(entry.id);
  }

  emitSaved(saved: SavedExprId, source?: WasmCacheOccurrenceSource): ReturnType<WasmValueCache["emitSaved"]> {
    const entry = this.#entries.entryForSaved(saved);
    const visible = this.#locals.get(entry.id);

    if (visible === undefined) {
      throw new Error(`saved expression ${saved} is not available in the active Wasm cache path`);
    }

    this.#consumeSavedExprOccurrence(entry, saved, source);
    this.#body.localGet(visible.local);
    this.#releaseIfComplete(entry.id);
    return visible.type;
  }

  #skipSaveExprInline(saved: SavedExprId): void {
    while (true) {
      const occurrence = this.#schedule.peek();

      if (occurrence === undefined) {
        throw new Error(`missing Wasm cache save-expr occurrence for saved expression ${saved}`);
      }

      if (occurrence.kind === "save-expr" && occurrence.saved === saved) {
        return;
      }

      if (occurrenceHasSaveExprSource(occurrence, saved)) {
        this.#schedule.consume(occurrence);
        this.#releaseIfComplete(occurrence.entry);
        continue;
      }

      throw new Error(
        `expected skipped save-expr child occurrence for saved expression ${saved}, ` +
        `found ${describeOccurrence(occurrence)}`
      );
    }
  }

  #assertSaveExprInlineCanStart(saved: SavedExprId): void {
    const occurrence = this.#schedule.peek();

    if (occurrence === undefined) {
      throw new Error(`missing Wasm cache save-expr occurrence for saved expression ${saved}`);
    }

    if (
      (occurrence.kind === "save-expr" && occurrence.saved === saved) ||
      occurrenceHasSaveExprSource(occurrence, saved)
    ) {
      return;
    }

    throw new Error(
      `expected Wasm cache save-expr occurrence for saved expression ${saved}, ` +
      `found ${describeOccurrence(occurrence)}`
    );
  }

  #consumeRecipeOccurrence(
    entry: WasmCacheEntry,
    recipe: ExprRecipe,
    source: WasmCacheOccurrenceSource
  ): WasmCacheRecipeOccurrence {
    const occurrence = this.#schedule.peek();

    if (
      occurrence === undefined ||
      occurrence.kind !== "recipe" ||
      occurrence.entry !== entry.id ||
      !sameSource(occurrence.source, source)
    ) {
      throw new Error(
        `expected Wasm cache recipe occurrence for entry ${entry.id}, ` +
        `found ${describeOccurrence(occurrence)}`
      );
    }

    this.#entries.assertSameRecipe(recipe, occurrence.recipe);
    this.#schedule.consume(occurrence);
    return occurrence;
  }

  #consumeSaveExprOccurrence(
    entry: WasmCacheEntry,
    saved: SavedExprId,
    recipe: ExprRecipe
  ): WasmCacheSaveExprOccurrence {
    const occurrence = this.#schedule.peek();

    if (
      occurrence === undefined ||
      occurrence.kind !== "save-expr" ||
      occurrence.entry !== entry.id ||
      occurrence.saved !== saved
    ) {
      throw new Error(
        `expected Wasm cache save-expr occurrence for saved expression ${saved}, ` +
        `found ${describeOccurrence(occurrence)}`
      );
    }

    this.#entries.assertSameRecipe(recipe, occurrence.recipe);
    this.#schedule.consume(occurrence);
    return occurrence;
  }

  #consumeSavedExprOccurrence(
    entry: WasmCacheEntry,
    saved: SavedExprId,
    source: WasmCacheOccurrenceSource | undefined
  ): WasmCacheSavedExprOccurrence {
    const occurrence = this.#schedule.peek();

    if (
      occurrence === undefined ||
      occurrence.kind !== "saved-expr" ||
      occurrence.entry !== entry.id ||
      occurrence.saved !== saved ||
      (source !== undefined && !sameSource(occurrence.source, source))
    ) {
      throw new Error(
        `expected Wasm cache saved-expr occurrence for saved expression ${saved}, ` +
        `found ${describeOccurrence(occurrence)}`
      );
    }

    this.#schedule.consume(occurrence);
    return occurrence;
  }

  #releaseIfComplete(entry: WasmCacheEntryId): void {
    const local = this.#locals.get(entry);

    if (local === undefined || this.#schedule.remainingForEntry(local.entry.id) !== 0) {
      return;
    }

    this.#locals.releaseEntry(entry);
  }
}
