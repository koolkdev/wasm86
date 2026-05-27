import type { ValueWidth } from "#wasm/codegen/value-width.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  type CachePlan,
  type Capture,
  type BlockEpochs,
  type SelectedValue
} from "#backends/wasm/jit/codegen/plan/reuse.js";
import type {
  Placement
} from "#backends/wasm/jit/codegen/plan/schedule-types.js";
import type { Path } from "#backends/wasm/jit/analysis/paths.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type {
  JitLoadResultValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import {
  LocalStore,
  type CapturedValue,
  type CachedUse
} from "./local-store.js";

export type {
  CachedHandle,
  CapturedValue,
  CachedUse
} from "./local-store.js";

export type ValueScope = Readonly<{
  withPath<T>(path: Path, emit: () => T): T;
}>;

export type PlannedValueCapture = Pick<Capture, "at" | "availability" | "value">;

export type ValueCache = Readonly<{
  // Emits a normal value use, reusing or teeing locals according to the reuse plan.
  emitForUse(
    at: Placement,
    value: JitValue,
    emitter: () => ValueWidth
  ): CachedUse;

  // Pins an already-materialized value for deferred use.
  retain(value: JitValue): CapturedValue | undefined;

  // Materializes a concrete planned capture owned by the caller.
  capture(
    capture: PlannedValueCapture,
    emitter: () => ValueWidth
  ): CapturedValue;

  // Materializes a load-result value only when the reuse plan selected it.
  define(
    at: Placement,
    value: JitLoadResultValue,
    emitter: () => ValueWidth
  ): CapturedValue | undefined;

  // Reports whether a value can be inlined without hiding a selected cache use.
  canInline(at: Placement, value: JitValue): boolean;
}>;

export type ValueCacheState = Readonly<{
  cache: ValueCache;
  scope: ValueScope;
}>;

export function createValueCache(
  body: WasmFunctionBodyEncoder,
  cachePlan: CachePlan,
  block: BlockEpochs
): ValueCacheState {
  const plan = cachePlan;
  const store = new LocalStore(body);

  return {
    cache: {
      emitForUse: (at, value, emitter) => {
        if (valueIsConsumerAtPlacement(at, value)) {
          const available = store.get(value);

          if (available !== undefined) {
            return available;
          }

          return store.tee(value, emitter());
        }

        return store.get(value) ?? { valueWidth: emitter() };
      },
      retain: (value) => store.retainAvailable(value),
      capture: (capture, emitter) => {
        epochForPlacement(capture.at);

        const available = store.retainAvailable(capture.value);

        if (available !== undefined) {
          return available;
        }

        if (!store.isCurrentPath(capture.availability)) {
          throw new Error("JIT value capture availability path is not active");
        }

        return store.set(capture.value, emitter());
      },
      define: (at, value, emitter) => {
        epochForPlacement(at);

        if (!valueIsSelected(plan.selected, value)) {
          return undefined;
        }

        const available = store.retainAvailable(value);

        if (available !== undefined) {
          return available;
        }

        return store.set(value, emitter());
      },
      canInline: (at, value) => !valueIsConsumerAtPlacement(at, value)
    },
    scope: {
      withPath: (path, emit) => store.withPath(path, emit)
    }
  };

  function valueIsConsumerAtPlacement(at: Placement, value: JitValue): boolean {
    return valueIsSelected(epochPlan(at)?.consumers ?? [], value);
  }

  function epochPlan(at: Placement) {
    return plan.epochs[epochForPlacement(at)];
  }

  function epochForPlacement(at: Placement): number {
    const epoch = block.opEpochs[at.opIndex];

    if (epoch === undefined) {
      throw new Error(`JIT value cache expression op index out of range: ${at.opIndex}`);
    }

    if (epoch !== at.epoch) {
      throw new Error(`JIT value cache placement epoch mismatch: ${placementKey(at)} expected ${epoch}`);
    }

    return epoch;
  }
}

function valueIsSelected(selected: readonly SelectedValue[], value: JitValue): boolean {
  const simplified = simplifyValue(value);

  return selected.some((entry) => valuesEqual(simplifyValue(entry.value), simplified));
}

function placementKey(placement: Placement): string {
  return `${placement.opIndex}:${placement.epoch}`;
}
