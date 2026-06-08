import type {
  BlockLayout,
  LayoutRegionId
} from "#ir/block/planning/layout/index.js";
import type { ValuePlan } from "#ir/block/planning/values/index.js";
import type {
  WasmCacheEntryId,
  WasmCachePlan
} from "../plan/index.js";

export type WasmCacheLifetimeBudget = Readonly<{
  entry: WasmCacheEntryId;
  ownerRegion: LayoutRegionId;
  remainingUses: number;
}>;

export type WasmCacheReleaseDecision =
  | Readonly<{ kind: "keep" }>
  | Readonly<{ kind: "release" }>;

export type WasmCacheLifetimeLocalBorrow = Readonly<{
  release(): WasmCacheReleaseDecision;
}>;

export type WasmCacheLifetimePlan = Readonly<{
  budgets: readonly WasmCacheLifetimeBudget[];
}>;

export type WasmCacheLifetimePlanInput = Readonly<{
  layout: BlockLayout;
  values: ValuePlan;
  cachePlan: WasmCachePlan;
}>;

export type WasmCacheLifetimeTracker = Readonly<{
  touchSelectedUse(input: Readonly<{
    entry: WasmCacheEntryId;
    ownerRegion: LayoutRegionId;
  }>): WasmCacheReleaseDecision;
  borrowSelectedLocal(input: Readonly<{
    entry: WasmCacheEntryId;
    ownerRegion: LayoutRegionId;
  }>): WasmCacheLifetimeLocalBorrow;
}>;
