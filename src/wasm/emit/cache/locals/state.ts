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
  WasmValueCacheLocalEmission,
  WasmValueCacheLocalOutput,
  WasmValueCacheOutput,
  WasmValueCacheStackEmission,
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

  constructor(input: WasmValueCacheInput) {
    this.#body = input.body;
    this.#scratch = input.scratch ?? new WasmLocalScratchAllocator(input.body);
    this.#entries = new WasmCacheEntryIndex(input.plan, input.values);
    this.#locals = new WasmValueCacheLocals(this.#scratch);
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
  ): WasmValueCacheStackEmission;
  emitUse(
    use: WasmValueCacheUse,
    emitInline: WasmValueCacheInlineEmitter,
    output: WasmValueCacheLocalOutput
  ): WasmValueCacheLocalEmission;
  emitUse(
    use: WasmValueCacheUse,
    emitInline: WasmValueCacheInlineEmitter,
    output?: WasmValueCacheOutput
  ): WasmEmittedValue | WasmValueCacheStackEmission | WasmValueCacheLocalEmission {
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
  ): WasmValueCacheStackEmission;
  emitRecipe(
    recipe: ExprRecipe,
    emitInline: WasmValueCacheInlineEmitter,
    output: WasmValueCacheLocalOutput
  ): WasmValueCacheLocalEmission;
  emitRecipe(
    recipe: ExprRecipe,
    emitInline: WasmValueCacheInlineEmitter,
    output?: WasmValueCacheOutput
  ): WasmEmittedValue | WasmValueCacheStackEmission | WasmValueCacheLocalEmission {
    if (output === undefined) {
      return this.#emitRecipeStack(recipe, emitInline).value;
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
  ): WasmValueCacheStackEmission {
    if (recipe.kind === "snapshot") {
      return this.#emitSnapshotStack(recipe.snapshot);
    }

    const entry = this.#entries.entryForRecipe(recipe);

    if (entry === undefined) {
      return uncachedStack(emitInline());
    }

    const active = this.#regions.activeRegion();
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    if (visible !== undefined) {
      this.#body.localGet(visible.local);
      return cachedStack(visible.value, visible.local);
    }

    const value = emitInline();
    const local = this.#locals.establish(entry, value, active);

    this.#body.localTee(local.local);
    return cachedStack(value, local.local);
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
      return localEmission(visible.value, visible.local);
    }

    const value = emitInline();
    const local = this.#locals.establish(entry, value, active);

    this.#body.localSet(local.local);
    return localEmission(value, local.local);
  }

  isRecipeSelected(recipe: ExprRecipe): ReturnType<WasmValueCache["isRecipeSelected"]> {
    return this.#entries.entryForRecipe(recipe) !== undefined;
  }

  ensureSnapshot(snapshot: ValueSnapshotId, recipe: ExprRecipe, emitInline: WasmValueCacheInlineEmitter): void {
    const entry = this.#entries.entryForSnapshot(snapshot);
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
  emitSnapshot(snapshot: ValueSnapshotId, output: WasmValueCacheStackOutput): WasmValueCacheStackEmission;
  emitSnapshot(snapshot: ValueSnapshotId, output: WasmValueCacheLocalOutput): WasmValueCacheLocalEmission;
  emitSnapshot(
    snapshot: ValueSnapshotId,
    output?: WasmValueCacheOutput
  ): WasmEmittedValue | WasmValueCacheStackEmission | WasmValueCacheLocalEmission {
    if (output === undefined) {
      return this.#emitSnapshotStack(snapshot).value;
    }

    switch (output.kind) {
      case "stack":
        return this.#emitSnapshotStack(snapshot);
      case "local":
        return this.#emitSnapshotLocal(snapshot);
    }
  }

  #emitSnapshotStack(snapshot: ValueSnapshotId): WasmValueCacheStackEmission {
    const entry = this.#entries.entryForSnapshot(snapshot);
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    if (visible === undefined) {
      throw new Error(`snapshot expression ${snapshot} is not available in the active Wasm cache path`);
    }

    this.#body.localGet(visible.local);
    return cachedStack(visible.value, visible.local);
  }

  #emitSnapshotLocal(snapshot: ValueSnapshotId): WasmValueCacheLocalEmission {
    const entry = this.#entries.entryForSnapshot(snapshot);
    const visible = this.#locals.get(entry.id, this.#regions.activeRegionChain());

    if (visible === undefined) {
      throw new Error(`snapshot expression ${snapshot} is not available in the active Wasm cache path`);
    }

    return localEmission(visible.value, visible.local);
  }
}

function uncachedStack(value: WasmValueCacheStackEmission["value"]): WasmValueCacheStackEmission {
  return {
    kind: "uncached",
    value
  };
}

function cachedStack(value: WasmValueCacheStackEmission["value"], local: number): WasmValueCacheStackEmission {
  return {
    kind: "cached",
    value,
    local
  };
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
