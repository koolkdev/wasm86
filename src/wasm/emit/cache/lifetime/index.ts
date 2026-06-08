export {
  planWasmCacheLifetime
} from "./plan.js";

export {
  createWasmCacheLifetimeTracker,
  wasmCacheLifetimeKeepTracker
} from "./tracker.js";

export type {
  WasmCacheLifetimeBudget,
  WasmCacheLifetimeLocalBorrow,
  WasmCacheLifetimePlan,
  WasmCacheLifetimePlanInput,
  WasmCacheLifetimeTracker,
  WasmCacheReleaseDecision
} from "./types.js";
