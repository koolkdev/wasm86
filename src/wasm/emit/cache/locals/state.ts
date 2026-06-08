import { assert } from "#common/assert.js";
import type { LayoutRegion } from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ValueSnapshotId
} from "#ir/block/planning/values/index.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { WasmCacheEntryIndex } from "../entries.js";
import type { WasmCacheLifetimeTracker } from "../lifetime/index.js";
import type { WasmCachedLocal } from "./locals.js";
import { WasmValueCacheLocals } from "./locals.js";
import { WasmCacheRegionStack } from "./regions.js";
import type {
  WasmValueCache,
  WasmValueCacheInlineEmitter,
  WasmValueCacheInput,
  WasmValueCacheLocalEmission,
  WasmValueCacheLocalOutput,
  WasmValueCacheOutput,
  WasmValueCacheStackOutput,
  WasmValueCacheUse
} from "./types.js";
import {
  wasmTypeOf,
  type WasmEmittedValue
} from "../../values/types.js";

export function createWasmValueCache(input: WasmValueCacheInput): WasmValueCache {
  return new WasmValueCacheState(input);
}

export class WasmValueCacheState implements WasmValueCache {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #scratch: WasmLocalScratchAllocator;
  readonly #entries: WasmCacheEntryIndex;
  readonly #regions = new WasmCacheRegionStack();
  readonly #locals: WasmValueCacheLocals;
  readonly #lifetime: WasmCacheLifetimeTracker;

  constructor(input: WasmValueCacheInput) {
    this.#body = input.body;
    this.#scratch = input.scratch ?? new WasmLocalScratchAllocator(input.body);
    this.#entries = new WasmCacheEntryIndex(input.plan, input.values);
    this.#locals = new WasmValueCacheLocals(this.#scratch);
    this.#lifetime = input.lifetime;
  }

  enterRegion(region: LayoutRegion): void {
    this.#regions.enterRegion(region);
  }

  leaveRegion(region: LayoutRegion): void {
    const active = this.#regions.leaveRegion(region);

    this.#locals.releaseOwnedBy(active);
  }

  emitUse(use: WasmValueCacheUse, emitInline: WasmValueCacheInlineEmitter): WasmEmittedValue;
  emitUse(
    use: WasmValueCacheUse,
    emitInline: WasmValueCacheInlineEmitter,
    output: WasmValueCacheStackOutput
  ): WasmEmittedValue;
  emitUse(
    use: WasmValueCacheUse,
    emitInline: WasmValueCacheInlineEmitter,
    output: WasmValueCacheLocalOutput
  ): WasmValueCacheLocalEmission;
  emitUse(
    use: WasmValueCacheUse,
    emitInline: WasmValueCacheInlineEmitter,
    output?: WasmValueCacheOutput
  ): WasmEmittedValue | WasmValueCacheLocalEmission {
    if (output === undefined) {
      return this.emitRecipe(use.recipe, emitInline);
    }

    switch (output.kind) {
      case "stack":
        return this.emitRecipe(use.recipe, emitInline, output);
      case "local":
        return this.emitRecipe(use.recipe, emitInline, output);
    }
  }

  emitRecipe(recipe: ExprRecipe, emitInline: WasmValueCacheInlineEmitter): WasmEmittedValue;
  emitRecipe(
    recipe: ExprRecipe,
    emitInline: WasmValueCacheInlineEmitter,
    output: WasmValueCacheStackOutput
  ): WasmEmittedValue;
  emitRecipe(
    recipe: ExprRecipe,
    emitInline: WasmValueCacheInlineEmitter,
    output: WasmValueCacheLocalOutput
  ): WasmValueCacheLocalEmission;
  emitRecipe(
    recipe: ExprRecipe,
    emitInline: WasmValueCacheInlineEmitter,
    output?: WasmValueCacheOutput
  ): WasmEmittedValue | WasmValueCacheLocalEmission {
    if (output === undefined) {
      return this.#emitRecipeStack(recipe, emitInline);
    }

    switch (output.kind) {
      case "stack":
        return this.#emitRecipeStack(recipe, emitInline);
      case "local":
        return this.#emitRecipeLocal(recipe, emitInline);
    }
  }

  #emitRecipeStack(
    recipe: ExprRecipe,
    emitInline: WasmValueCacheInlineEmitter
  ): WasmEmittedValue {
    if (recipe.kind === "snapshot") {
      return this.#emitSnapshotStack(recipe.snapshot);
    }

    const entry = this.#entries.entryForRecipe(recipe);

    if (entry === undefined) {
      return emitInline();
    }

    const active = this.#regions.activeRegion();
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    if (visible !== undefined) {
      this.#body.localGet(visible.local);
      this.#releaseAfterStackUse(visible);
      return visible.value;
    }

    const value = emitInline();
    const local = this.#locals.establish(entry, value, active);

    this.#body.localTee(local.local);
    this.#releaseAfterStackUse(local);
    return value;
  }

  #emitRecipeLocal(
    recipe: ExprRecipe,
    emitInline: WasmValueCacheInlineEmitter
  ): WasmValueCacheLocalEmission {
    if (recipe.kind === "snapshot") {
      return this.#emitSnapshotLocal(recipe.snapshot);
    }

    const entry = this.#entries.entryForRecipe(recipe);

    if (entry === undefined) {
      const value = emitInline();
      const local = this.#scratch.allocLocal(wasmTypeOf(value));

      this.#body.localSet(local);
      return localEmission(value, local, () => this.#scratch.freeLocal(local));
    }

    const active = this.#regions.activeRegion();
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    if (visible !== undefined) {
      return this.#cachedLocalEmission(visible);
    }

    const value = emitInline();
    const local = this.#locals.establish(entry, value, active);

    this.#body.localSet(local.local);
    return this.#cachedLocalEmission(local);
  }

  isRecipeSelected(recipe: ExprRecipe): ReturnType<WasmValueCache["isRecipeSelected"]> {
    return this.#entries.entryForRecipe(recipe) !== undefined;
  }

  ensureSnapshot(snapshot: ValueSnapshotId, recipe: ExprRecipe, emitInline: WasmValueCacheInlineEmitter): void {
    const entry = this.#entries.requireEntryForSnapshot(snapshot);
    const active = this.#regions.activeRegion();
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    this.#entries.assertSameRecipe(recipe, entry.recipe);

    if (visible !== undefined) {
      return;
    }

    const value = emitInline();
    const local = this.#locals.establish(entry, value, active);

    this.#body.localSet(local.local);
  }

  emitSnapshot(snapshot: ValueSnapshotId): WasmEmittedValue;
  emitSnapshot(snapshot: ValueSnapshotId, output: WasmValueCacheStackOutput): WasmEmittedValue;
  emitSnapshot(snapshot: ValueSnapshotId, output: WasmValueCacheLocalOutput): WasmValueCacheLocalEmission;
  emitSnapshot(
    snapshot: ValueSnapshotId,
    output?: WasmValueCacheOutput
  ): WasmEmittedValue | WasmValueCacheLocalEmission {
    if (output === undefined) {
      return this.#emitSnapshotStack(snapshot);
    }

    switch (output.kind) {
      case "stack":
        return this.#emitSnapshotStack(snapshot);
      case "local":
        return this.#emitSnapshotLocal(snapshot);
    }
  }

  #emitSnapshotStack(snapshot: ValueSnapshotId): WasmEmittedValue {
    const entry = this.#entries.requireEntryForSnapshot(snapshot);
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    assert(visible !== undefined, `snapshot expression ${snapshot} is not available in the active Wasm cache path`);

    this.#body.localGet(visible.local);
    this.#releaseAfterStackUse(visible);
    return visible.value;
  }

  #emitSnapshotLocal(snapshot: ValueSnapshotId): WasmValueCacheLocalEmission {
    const entry = this.#entries.requireEntryForSnapshot(snapshot);
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    assert(visible !== undefined, `snapshot expression ${snapshot} is not available in the active Wasm cache path`);

    return this.#cachedLocalEmission(visible);
  }

  #releaseAfterStackUse(local: WasmCachedLocal): void {
    const decision = this.#lifetime.touchSelectedUse({
      entry: local.entry.id,
      ownerRegion: local.owner.region.id
    });

    if (decision.kind === "release") {
      this.#locals.releaseEntry(local.entry.id, local.owner);
    }
  }

  #cachedLocalEmission(local: WasmCachedLocal): WasmValueCacheLocalEmission {
    const borrow = this.#lifetime.borrowSelectedLocal({
      entry: local.entry.id,
      ownerRegion: local.owner.region.id
    });

    return localEmission(local.value, local.local, () => {
      if (borrow.release().kind === "release") {
        this.#locals.releaseEntry(local.entry.id, local.owner);
      }
    });
  }
}

function localEmission(
  value: WasmValueCacheLocalEmission["value"],
  local: number,
  release: () => void = () => {}
): WasmValueCacheLocalEmission {
  return {
    value,
    local,
    release
  };
}
