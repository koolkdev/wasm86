import { wasmValueType } from "#backends/wasm/encoder/types.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type {
  WasmIrCachedValueHandle,
  WasmIrCachedValueLocal,
  WasmIrValueCache
} from "#backends/wasm/codegen/emit.js";
import type { IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type { ValueWidth } from "#backends/wasm/codegen/value-width.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import {
  jitValueKey,
  simplifyJitValue,
  jitValuesEqual,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import {
  type JitExpressionValueCachePlan,
  type JitValueUseCount
} from "#backends/wasm/jit/codegen/plan/value-cache.js";
import {
  jitTimelineExpressionValueAt,
  jitTimelineValueRefValueAt
} from "#backends/wasm/jit/codegen/plan/value-timeline.js";

export type { JitExpressionValueCachePlan, JitValueUseCount } from "#backends/wasm/jit/codegen/plan/value-cache.js";

export type JitCachedValueUse = Readonly<{
  valueWidth: ValueWidth;
  local?: number;
}>;

export type JitCachedValueHandle = WasmIrCachedValueHandle;
export type JitCachedValueLocal = WasmIrCachedValueLocal;
export type JitValueCacheAvailabilitySnapshot = Readonly<{
  entries: readonly JitValueCacheAvailabilitySnapshotEntry[];
}>;
export type JitValueCacheAvailabilitySnapshotEntry = Readonly<{
  key: string;
  available: boolean;
  valueWidth: ValueWidth | undefined;
  local: number | undefined;
}>;
export type JitValueCacheRuntimeAvailabilitySnapshot = Readonly<{
  currentEpoch: number;
  store: JitValueCacheAvailabilitySnapshot;
}>;

export type JitValueCacheRuntime = WasmIrValueCache & Readonly<{
  beginInstruction(index: number): void;
  beginExpressionOp(opIndex: number): void;
  snapshotAvailability(): JitValueCacheRuntimeAvailabilitySnapshot;
  restoreAvailability(snapshot: JitValueCacheRuntimeAvailabilitySnapshot): void;
  emitJitValueForUse(value: JitValue, emitter: () => ValueWidth): JitCachedValueUse;
  captureJitValueForReuse(
    value: JitValue,
    emitter: () => ValueWidth
  ): JitCachedValueLocal | undefined;
  jitValueForExpression(value: IrValueExpr): JitValue | undefined;
  jitValueForValueRef(value: ValueRef): JitValue | undefined;
}>;

type CachedJitValue = {
  readonly value: JitValue;
  local?: CachedJitLocal | undefined;
  valueWidth: ValueWidth | undefined;
  available: boolean;
};

type CachedJitLocal = {
  local: number;
  ownerCount: number;
  entry?: CachedJitValue | undefined;
};

export class JitValueLocalStore {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #entries = new Map<string, CachedJitValue>();
  readonly #freeLocals: CachedJitLocal[] = [];
  readonly #localsByIndex = new Map<number, CachedJitLocal>();

  constructor(body: WasmFunctionBodyEncoder, useCounts: readonly JitValueUseCount[]) {
    this.#body = body;

    for (const useCount of useCounts) {
      const value = simplifyJitValue(useCount.value);

      this.#entries.set(jitValueKey(value), {
        value,
        valueWidth: undefined,
        available: false
      });
    }
  }

  emitForUse(value: JitValue, emitter: () => ValueWidth): ValueWidth {
    return this.emitForUseWithLocal(value, emitter).valueWidth;
  }

  emitForUseWithLocal(value: JitValue, emitter: () => ValueWidth): JitCachedValueUse {
    const entry = this.#entryFor(value);

    if (entry === undefined) {
      return { valueWidth: emitter() };
    }

    const local = this.#localForEntry(entry).local;

    if (entry.available) {
      this.#body.localGet(local);
      return { valueWidth: requiredValueWidth(entry), local };
    }

    const valueWidth = emitter();

    this.#body.localTee(local);
    entry.valueWidth = valueWidth;
    entry.available = true;
    return { valueWidth, local };
  }

  // Pre-fill a selected cache entry for consumers that need the value later,
  // without leaving it on the stack. Returns true only when this call emitted
  // the expression and stored it with local.set.
  captureForReuse(value: JitValue, emitter: () => ValueWidth): JitCachedValueLocal | undefined {
    const entry = this.#entryFor(value);

    if (entry === undefined) {
      return undefined;
    }

    const cacheLocal = this.#localForEntry(entry);

    if (entry.available) {
      return {
        ...this.#handleForLocal(cacheLocal, requiredValueWidth(entry)),
        valueWidth: requiredValueWidth(entry),
        emitted: false
      };
    }

    const valueWidth = emitter();

    this.#body.localSet(cacheLocal.local);
    entry.valueWidth = valueWidth;
    entry.available = true;
    return {
      ...this.#handleForLocal(cacheLocal, valueWidth),
      valueWidth,
      emitted: true
    };
  }

  snapshotAvailability(): JitValueCacheAvailabilitySnapshot {
    const entries: JitValueCacheAvailabilitySnapshotEntry[] = [];

    for (const [key, entry] of this.#entries) {
      entries.push({
        key,
        available: entry.available,
        valueWidth: entry.valueWidth,
        local: entry.local?.local
      });
    }

    return { entries };
  }

  restoreAvailability(snapshot: JitValueCacheAvailabilitySnapshot): void {
    const entriesByKey = new Map(snapshot.entries.map((entry) => [entry.key, entry]));

    for (const [key, entry] of this.#entries) {
      const availability = entriesByKey.get(key);

      if (availability === undefined) {
        throw new Error(`missing JIT value cache availability snapshot entry: ${key}`);
      }

      const currentLocal = entry.local;
      const restoredLocal = availability.local === undefined
        ? undefined
        : this.#localSnapshotRef(availability.local);

      if (currentLocal !== undefined && currentLocal !== restoredLocal) {
        currentLocal.entry = undefined;

        if (currentLocal.ownerCount === 0) {
          this.#freeLocals.push(currentLocal);
        }
      }

      entry.available = availability.available;
      entry.valueWidth = availability.valueWidth;
      entry.local = restoredLocal;

      if (entry.local !== undefined) {
        entry.local.entry = entry;
      }

      if (!entry.available) {
        this.#detachUnavailableOwnedLocal(entry);
      }
    }
  }

  forgetWhere(predicate: (value: JitValue) => boolean): void {
    for (const entry of this.#entries.values()) {
      if (predicate(entry.value)) {
        entry.available = false;
        entry.valueWidth = undefined;

        this.#detachUnavailableOwnedLocal(entry);
      }
    }
  }

  #entryFor(value: JitValue): CachedJitValue | undefined {
    const simplified = simplifyJitValue(value);
    const entry = this.#entries.get(jitValueKey(simplified));

    return entry !== undefined && jitValuesEqual(entry.value, simplified) ? entry : undefined;
  }

  #localForEntry(entry: CachedJitValue): CachedJitLocal {
    if (entry.local === undefined) {
      const cacheLocal = this.#freeLocals.pop() ?? {
        local: this.#body.addLocal(wasmValueType.i32),
        ownerCount: 0
      };

      this.#localsByIndex.set(cacheLocal.local, cacheLocal);
      cacheLocal.entry = entry;
      entry.local = cacheLocal;
    }

    return entry.local;
  }

  #handleForLocal(cacheLocal: CachedJitLocal, valueWidth: ValueWidth): JitCachedValueHandle {
    cacheLocal.ownerCount += 1;

    let released = false;

    return {
      local: cacheLocal.local,
      valueWidth,
      retain: () => {
        if (released) {
          throw new Error("JIT cached value handle was retained after release");
        }

        return this.#handleForLocal(cacheLocal, valueWidth);
      },
      release: () => {
        if (released) {
          throw new Error("JIT cached value handle was released more than once");
        }

        released = true;
        cacheLocal.ownerCount -= 1;

        if (cacheLocal.ownerCount < 0) {
          throw new Error("JIT cached value handle owner count became negative");
        }

        if (cacheLocal.ownerCount === 0 && cacheLocal.entry === undefined) {
          this.#freeLocals.push(cacheLocal);
        }
      }
    };
  }

  #detachUnavailableOwnedLocal(entry: CachedJitValue): void {
    if (entry.local !== undefined && entry.local.ownerCount !== 0) {
      entry.local.entry = undefined;
      entry.local = undefined;
    }
  }

  #localSnapshotRef(local: number): CachedJitLocal {
    const cacheLocal = this.#localsByIndex.get(local);

    if (cacheLocal === undefined) {
      throw new Error(`JIT value cache availability snapshot references unknown local: ${local}`);
    }

    return cacheLocal;
  }
}

export function createJitValueCacheRuntime(
  body: WasmFunctionBodyEncoder,
  plan: JitExpressionValueCachePlan | undefined
): JitValueCacheRuntime | undefined {
  if (plan === undefined || plan.selectedUseCounts.length === 0) {
    return undefined;
  }

  const cachePlan = plan;
  const store = new JitValueLocalStore(body, cachePlan.selectedUseCounts);
  let currentEpoch = 0;
  let currentInstructionIndex = 0;
  let currentExpressionOpIndex = 0;

  return {
    beginInstruction: (index) => {
      if (index < 0 || index >= cachePlan.instructionPlans.length) {
        throw new Error(`JIT value cache instruction index out of range: ${index}`);
      }

      currentInstructionIndex = index;
      currentExpressionOpIndex = 0;
      currentEpoch = currentInstructionPlan().epochByExpressionOpIndex[0] ?? currentEpoch;
    },
    beginExpressionOp: (opIndex) => {
      const instructionPlan = currentInstructionPlan();

      if (opIndex < 0 || opIndex >= instructionPlan.valueTimeline.expressionValuesByExpressionOpIndex.length) {
        throw new Error(`JIT value cache expression op index out of range: ${opIndex}`);
      }

      currentExpressionOpIndex = opIndex;
      currentEpoch = instructionPlan.epochByExpressionOpIndex[opIndex] ?? currentEpoch;
    },
    emitForUse: (value, emitter) => {
      if (value.kind === "var") {
        return emitter();
      }

      const jitValue = jitValueForExpressionAtCurrentOp(value);

      return jitValue !== undefined && valueIsSelectedInEpoch(jitValue)
        ? store.emitForUse(jitValue, emitter)
        : emitter();
    },
    emitJitValueForUse: (value, emitter) =>
      valueIsSelectedInEpoch(value)
        ? store.emitForUseWithLocal(value, emitter)
        : { valueWidth: emitter() },
    captureForReuse: (value, emitter) => {
      if (value.kind === "var") {
        return undefined;
      }

      const jitValue = jitValueForExpressionAtCurrentOp(value);

      return jitValue !== undefined && valueIsSelectedInEpoch(jitValue)
        ? store.captureForReuse(jitValue, emitter)
        : undefined;
    },
    captureJitValueForReuse: (value, emitter) =>
      valueIsSelectedInEpoch(value)
        ? store.captureForReuse(value, emitter)
        : undefined,
    snapshotAvailability: () => ({
      currentEpoch,
      store: store.snapshotAvailability()
    }),
    restoreAvailability: (snapshot) => {
      currentEpoch = snapshot.currentEpoch;
      store.restoreAvailability(snapshot.store);
    },
    jitValueForExpression: (value) => jitValueForExpressionAtCurrentOp(value),
    jitValueForValueRef: (value) => jitTimelineValueRefValueAt(
      currentInstructionPlan().valueTimeline,
      currentExpressionOpIndex,
      value
    )
  };

  function valueIsSelectedInEpoch(value: JitValue): boolean {
    return valueIsSelected(cachePlan.selectedConsumerValuesByEpoch[currentEpoch] ?? [], value) ||
      valueIsCaptureSelected(cachePlan.captureValuesByEpoch[currentEpoch] ?? [], value);
  }

  function currentInstructionPlan() {
    const instructionPlan = cachePlan.instructionPlans[currentInstructionIndex];

    if (instructionPlan === undefined) {
      throw new Error(`missing JIT value cache instruction plan: ${currentInstructionIndex}`);
    }

    return instructionPlan;
  }

  function jitValueForExpressionAtCurrentOp(value: IrValueExpr): JitValue | undefined {
    return jitTimelineExpressionValueAt(
      currentInstructionPlan().valueTimeline,
      currentExpressionOpIndex,
      value
    );
  }
}

function requiredValueWidth(entry: CachedJitValue): ValueWidth {
  if (entry.valueWidth === undefined) {
    throw new Error("cached JIT value is available without width metadata");
  }

  return entry.valueWidth;
}

function valueIsSelected(selected: readonly JitValueUseCount[], value: JitValue): boolean {
  const simplified = simplifyJitValue(value);

  return selected.some((entry) => jitValuesEqual(simplifyJitValue(entry.value), simplified));
}

function valueIsCaptureSelected(selected: readonly JitValue[], value: JitValue): boolean {
  const simplified = simplifyJitValue(value);

  return selected.some((entry) => jitValuesEqual(simplifyJitValue(entry), simplified));
}
