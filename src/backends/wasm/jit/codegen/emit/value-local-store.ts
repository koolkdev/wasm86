import { wasmValueType } from "#backends/wasm/encoder/types.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type {
  WasmIrCachedValueHandle,
  WasmIrCachedValueLocal,
  WasmIrValueCache
} from "#backends/wasm/codegen/emit.js";
import type { IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type { ValueWidth } from "#backends/wasm/codegen/value-width.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import {
  jitValueKey,
  jitValueReadsReg,
  simplifyJitValue,
  jitValuesEqual,
  jitValueUsesSymbolicReg,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import type { OperandWidth } from "#x86/isa/types.js";
import {
  shouldCacheValue,
  type JitExpressionValueCachePlan,
  type JitValueUseCount
} from "#backends/wasm/jit/codegen/plan/value-cache.js";
import { jitInstructionWrittenReg } from "#backends/wasm/jit/codegen/plan/operand-analysis.js";

export type { JitExpressionValueCachePlan, JitValueUseCount } from "#backends/wasm/jit/codegen/plan/value-cache.js";

export type JitCachedValueUse = Readonly<{
  valueWidth: ValueWidth;
  local?: number;
}>;

export type JitCachedValueHandle = WasmIrCachedValueHandle;
export type JitCachedValueLocal = WasmIrCachedValueLocal;

export type JitValueCacheRuntime = WasmIrValueCache & Readonly<{
  beginInstruction(index: number): void;
  notifyWrite(target: IrStorageExpr, accessWidth: OperandWidth): void;
  emitJitValueForUse(value: JitValue, emitter: () => ValueWidth): JitCachedValueUse;
  captureJitValueForReuse(value: JitValue, emitter: () => ValueWidth): JitCachedValueLocal | undefined;
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

  constructor(body: WasmFunctionBodyEncoder, useCounts: readonly JitValueUseCount[]) {
    this.#body = body;

    for (const useCount of useCounts) {
      const value = simplifyJitValue(useCount.value);

      if (shouldCacheValue(value, useCount.useCount)) {
        this.#entries.set(jitValueKey(value), {
          value,
          valueWidth: undefined,
          available: false
        });
      }
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
  captureForReuse(
    value: JitValue,
    emitter: () => ValueWidth
  ): JitCachedValueLocal | undefined {
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

  forgetWhere(predicate: (value: JitValue) => boolean): void {
    for (const entry of this.#entries.values()) {
      if (predicate(entry.value)) {
        entry.available = false;
        entry.valueWidth = undefined;

        if (entry.local !== undefined && entry.local.ownerCount !== 0) {
          entry.local.entry = undefined;
          entry.local = undefined;
        }
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

  return {
    beginInstruction: (index) => {
      if (index < 0 || index >= cachePlan.instructionPlans.length) {
        throw new Error(`JIT value cache instruction index out of range: ${index}`);
      }

      currentInstructionIndex = index;
    },
    emitForUse: (value, emitter) => {
      const jitValue = currentInstructionPlan().expressionValues.get(value);

      return jitValue !== undefined && valueIsSelectedInEpoch(jitValue)
        ? store.emitForUse(jitValue, emitter)
        : emitter();
    },
    emitJitValueForUse: (value, emitter) =>
      valueIsSelectedInEpoch(value)
        ? store.emitForUseWithLocal(value, emitter)
        : { valueWidth: emitter() },
    captureForReuse: (value, emitter) => {
      const jitValue = currentInstructionPlan().expressionValues.get(value);

      return jitValue !== undefined && valueIsSelectedInEpoch(jitValue)
        ? store.captureForReuse(jitValue, emitter)
        : undefined;
    },
    captureJitValueForReuse: (value, emitter) =>
      valueIsSelectedInEpoch(value)
        ? store.captureForReuse(value, emitter)
        : undefined,
    jitValueForExpression: (value) =>
      currentInstructionPlan().expressionValues.get(value) ?? jitValueForExpressionRef(value),
    jitValueForValueRef: (value) => {
      switch (value.kind) {
        case "const":
          return { kind: "const", type: value.type, value: value.value };
        case "var":
          return currentInstructionPlan().valueRefValues.get(value.id);
        case "nextEip":
          return undefined;
      }
    },
    notifyWrite: (target, accessWidth) => {
      const reg = jitInstructionWrittenReg(currentInstructionPlan(), target, accessWidth);

      if (reg === undefined) {
        return;
      }

      store.forgetWhere((value) =>
        jitValueReadsReg(value, reg) || jitValueUsesSymbolicReg(value, reg)
      );
      currentEpoch = Math.min(currentEpoch + 1, cachePlan.selectedConsumerValuesByEpoch.length - 1);
    }
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

  function jitValueForExpressionRef(value: IrValueExpr): JitValue | undefined {
    switch (value.kind) {
      case "const":
        return { kind: "const", type: value.type, value: value.value };
      case "var":
        return currentInstructionPlan().valueRefValues.get(value.id);
      case "nextEip":
        return undefined;
      default:
        return undefined;
    }
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
