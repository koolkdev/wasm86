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
import type { WasmValueType } from "#wasm/encoder/types.js";
import type { WasmCachePlan } from "../plan/index.js";

export type WasmValueCacheUse = Readonly<{
  id: LayoutValueUseId;
  recipe: ExprRecipe;
}>;

export type WasmValueCacheInlineEmitter = () => WasmValueType;

export type WasmValueCache = Readonly<{
  enterRegion(region: LayoutRegion): void;
  leaveRegion(region: LayoutRegion): void;
  emitUse(use: WasmValueCacheUse, emitInline: WasmValueCacheInlineEmitter): WasmValueType;
  emitRecipe(
    recipe: ExprRecipe,
    emitInline: WasmValueCacheInlineEmitter
  ): WasmValueType;
  isRecipeSelected(recipe: ExprRecipe): boolean;
  ensureSnapshot(snapshot: ValueSnapshotId, recipe: ExprRecipe, emitInline: WasmValueCacheInlineEmitter): void;
  emitSnapshot(snapshot: ValueSnapshotId): WasmValueType;
}>;

export type WasmValueCacheInput = Readonly<{
  plan: WasmCachePlan;
  values: Pick<ValuePlan, "recipes">;
  body: WasmFunctionBodyEncoder;
  scratch?: WasmLocalScratchAllocator;
}>;
