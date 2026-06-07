import type {
  LayoutRegion,
  LayoutValueUseId
} from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ValueSnapshotId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmCachePlan } from "../plan/index.js";
import type { WasmEmittedValue } from "../../values/types.js";

export type WasmValueCacheUse = Readonly<{
  id: LayoutValueUseId;
  recipe: ExprRecipe;
}>;

export type WasmValueCacheInlineEmitter = () => WasmEmittedValue;

export type WasmValueCache = Readonly<{
  enterRegion(region: LayoutRegion): void;
  leaveRegion(region: LayoutRegion): void;
  emitUse(use: WasmValueCacheUse, emitInline: WasmValueCacheInlineEmitter): WasmEmittedValue;
  emitRecipe(
    recipe: ExprRecipe,
    emitInline: WasmValueCacheInlineEmitter
  ): WasmEmittedValue;
  isRecipeSelected(recipe: ExprRecipe): boolean;
  ensureSnapshot(snapshot: ValueSnapshotId, recipe: ExprRecipe, emitInline: WasmValueCacheInlineEmitter): void;
  emitSnapshot(snapshot: ValueSnapshotId): WasmEmittedValue;
}>;

export type WasmValueCacheInput = Readonly<{
  plan: WasmCachePlan;
  values: Pick<ValuePlan, "recipes">;
  body: WasmFunctionBodyEncoder;
  scratch?: WasmLocalScratchAllocator;
}>;
