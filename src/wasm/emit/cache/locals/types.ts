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

export type WasmValueCacheStackEmission =
  | Readonly<{
      kind: "uncached";
      value: WasmEmittedValue;
    }>
  | Readonly<{
      kind: "cached";
      value: WasmEmittedValue;
      local: number;
    }>;

export type WasmValueCacheLocalEmission = Readonly<{
  value: WasmEmittedValue;
  local: number;
  release: () => void;
}>;

export type WasmValueCacheStackOutput = Readonly<{ kind: "stack" }>;
export type WasmValueCacheLocalOutput = Readonly<{ kind: "local" }>;
export type WasmValueCacheOutput = WasmValueCacheStackOutput | WasmValueCacheLocalOutput;

export const wasmValueCacheOutput = Object.freeze({
  stack: Object.freeze({ kind: "stack" } satisfies WasmValueCacheStackOutput),
  local: Object.freeze({ kind: "local" } satisfies WasmValueCacheLocalOutput)
});

export type WasmValueCache = Readonly<{
  enterRegion(region: LayoutRegion): void;
  leaveRegion(region: LayoutRegion): void;
  emitUse: {
    (use: WasmValueCacheUse, emitInline: WasmValueCacheInlineEmitter): WasmEmittedValue;
    (
      use: WasmValueCacheUse,
      emitInline: WasmValueCacheInlineEmitter,
      output: WasmValueCacheStackOutput
    ): WasmValueCacheStackEmission;
    (
      use: WasmValueCacheUse,
      emitInline: WasmValueCacheInlineEmitter,
      output: WasmValueCacheLocalOutput
    ): WasmValueCacheLocalEmission;
  };
  emitRecipe: {
    (recipe: ExprRecipe, emitInline: WasmValueCacheInlineEmitter): WasmEmittedValue;
    (
      recipe: ExprRecipe,
      emitInline: WasmValueCacheInlineEmitter,
      output: WasmValueCacheStackOutput
    ): WasmValueCacheStackEmission;
    (
      recipe: ExprRecipe,
      emitInline: WasmValueCacheInlineEmitter,
      output: WasmValueCacheLocalOutput
    ): WasmValueCacheLocalEmission;
  };
  isRecipeSelected(recipe: ExprRecipe): boolean;
  ensureSnapshot(snapshot: ValueSnapshotId, recipe: ExprRecipe, emitInline: WasmValueCacheInlineEmitter): void;
  emitSnapshot: {
    (snapshot: ValueSnapshotId): WasmEmittedValue;
    (snapshot: ValueSnapshotId, output: WasmValueCacheStackOutput): WasmValueCacheStackEmission;
    (snapshot: ValueSnapshotId, output: WasmValueCacheLocalOutput): WasmValueCacheLocalEmission;
  };
}>;

export type WasmValueCacheInput = Readonly<{
  plan: WasmCachePlan;
  values: Pick<ValuePlan, "recipes">;
  body: WasmFunctionBodyEncoder;
  scratch?: WasmLocalScratchAllocator;
}>;
