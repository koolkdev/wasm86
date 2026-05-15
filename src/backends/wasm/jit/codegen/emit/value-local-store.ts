import { wasmValueType } from "#backends/wasm/encoder/types.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { ValueWidth } from "#backends/wasm/codegen/value-width.js";
import { valueKey } from "#backends/wasm/jit/ir/values/keys.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  type JitValueCachePlan,
  type JitValueUseCount
} from "#backends/wasm/jit/codegen/plan/value-cache.js";
import {
  rootPathId,
  type Path
} from "#backends/wasm/jit/analysis/paths.js";

export type { JitValueCachePlan, JitValueUseCount } from "#backends/wasm/jit/codegen/plan/value-cache.js";

export type JitCachedValueUse = Readonly<{
  valueWidth: ValueWidth;
  local?: number;
}>;

export type JitCachedValueHandle = Readonly<{
  local: number;
  valueWidth: ValueWidth;
  retain(): JitCachedValueHandle;
  release(): void;
}>;
export type JitCachedValueLocal = JitCachedValueHandle & Readonly<{
  emitted: boolean;
}>;

export type JitValueCacheRuntime = Readonly<{
  beginInstruction(index: number): void;
  beginExpressionOp(opIndex: number): void;
  enterPath(path: Path): void;
  leavePath(): void;
  emitForUse(value: JitValue, emitter: () => ValueWidth): JitCachedValueUse;
  captureForReuse(
    value: JitValue,
    emitter: () => ValueWidth
  ): JitCachedValueLocal | undefined;
  canEmitInline(value: JitValue): boolean;
}>;

type CachedJitValue = {
  readonly value: JitValue;
  readonly availabilitiesByPath: Map<string, CachedJitAvailability>;
};

type CachedJitAvailability = {
  entry: CachedJitValue;
  pathKey: string;
  local: CachedJitLocal;
  valueWidth: ValueWidth;
};

type CachedJitLocal = {
  local: number;
  ownerCount: number;
  availability?: CachedJitAvailability | undefined;
  free: boolean;
};

type JitPathFrame = {
  previousPathKey: string;
  pathKey: string;
  clearCreatedAvailabilitiesOnLeave: boolean;
  createdAvailabilities: Set<CachedJitAvailability>;
};

export class JitValueLocalStore {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #entries = new Map<string, CachedJitValue>();
  readonly #freeLocals: CachedJitLocal[] = [];
  #currentPathKey = rootPathKey();
  readonly #pathStack: JitPathFrame[] = [];

  constructor(body: WasmFunctionBodyEncoder, useCounts: readonly JitValueUseCount[]) {
    this.#body = body;

    for (const useCount of useCounts) {
      const value = simplifyValue(useCount.value);

      this.#entries.set(valueKey(value), {
        value,
        availabilitiesByPath: new Map()
      });
    }
  }

  emitForUse(value: JitValue, emitter: () => ValueWidth): ValueWidth {
    return this.emitForUseWithLocal(value, emitter).valueWidth;
  }

  enterPath(path: Path): void {
    const pathKey = valuePathKey(path);

    this.#pathStack.push({
      previousPathKey: this.#currentPathKey,
      pathKey,
      clearCreatedAvailabilitiesOnLeave: pathKey !== rootPathKey() &&
        pathKey !== this.#currentPathKey,
      createdAvailabilities: new Set()
    });
    this.#currentPathKey = pathKey;
  }

  leavePath(): void {
    const frame = this.#pathStack.pop();

    if (frame === undefined) {
      throw new Error("JIT value cache path stack underflow");
    }

    if (frame.clearCreatedAvailabilitiesOnLeave) {
      for (const availability of frame.createdAvailabilities) {
        this.#removeAvailability(availability);
      }
    }

    this.#currentPathKey = frame.previousPathKey;
  }

  emitForUseWithLocal(value: JitValue, emitter: () => ValueWidth): JitCachedValueUse {
    const entry = this.#entryFor(value);

    if (entry === undefined) {
      return { valueWidth: emitter() };
    }

    const availability = this.#visibleAvailability(entry);

    if (availability !== undefined) {
      this.#body.localGet(availability.local.local);
      return { valueWidth: availability.valueWidth, local: availability.local.local };
    }

    const valueWidth = emitter();
    const newAvailability = this.#availabilityForCurrentPath(entry, valueWidth);

    this.#body.localTee(newAvailability.local.local);
    return { valueWidth, local: newAvailability.local.local };
  }

  // Pre-fill a selected cache entry for consumers that need the value later,
  // without leaving it on the stack. Returns true only when this call emitted
  // the expression and stored it with local.set.
  captureForReuse(value: JitValue, emitter: () => ValueWidth): JitCachedValueLocal | undefined {
    const entry = this.#entryFor(value);

    if (entry === undefined) {
      return undefined;
    }

    const availability = this.#visibleAvailability(entry);

    if (availability !== undefined) {
      return {
        ...this.#handleForLocal(availability.local, availability.valueWidth),
        valueWidth: availability.valueWidth,
        emitted: false
      };
    }

    const valueWidth = emitter();
    const newAvailability = this.#availabilityForCurrentPath(entry, valueWidth);

    this.#body.localSet(newAvailability.local.local);
    return {
      ...this.#handleForLocal(newAvailability.local, valueWidth),
      valueWidth,
      emitted: true
    };
  }

  emitAvailableForUse(value: JitValue): JitCachedValueUse | undefined {
    const entry = this.#entryFor(value);
    const availability = entry === undefined ? undefined : this.#visibleAvailability(entry);

    if (availability === undefined) {
      return undefined;
    }

    this.#body.localGet(availability.local.local);
    return { valueWidth: availability.valueWidth, local: availability.local.local };
  }

  captureAvailableForReuse(value: JitValue): JitCachedValueLocal | undefined {
    const entry = this.#entryFor(value);
    const availability = entry === undefined ? undefined : this.#visibleAvailability(entry);

    if (availability === undefined) {
      return undefined;
    }

    return {
      ...this.#handleForLocal(availability.local, availability.valueWidth),
      valueWidth: availability.valueWidth,
      emitted: false
    };
  }

  forgetWhere(predicate: (value: JitValue) => boolean): void {
    for (const entry of this.#entries.values()) {
      if (predicate(entry.value)) {
        this.#clearAvailabilities(entry);
      }
    }
  }

  #entryFor(value: JitValue): CachedJitValue | undefined {
    const simplified = simplifyValue(value);
    const entry = this.#entries.get(valueKey(simplified));

    return entry !== undefined && valuesEqual(entry.value, simplified) ? entry : undefined;
  }

  #visibleAvailability(entry: CachedJitValue): CachedJitAvailability | undefined {
    for (let index = this.#pathStack.length - 1; index >= 0; index -= 1) {
      const frame = this.#pathStack[index];

      if (frame === undefined) {
        throw new Error(`missing JIT value cache path frame: ${index}`);
      }

      const availability = entry.availabilitiesByPath.get(frame.pathKey);

      if (availability !== undefined) {
        return availability;
      }
    }

    return entry.availabilitiesByPath.get(rootPathKey());
  }

  #availabilityForCurrentPath(entry: CachedJitValue, valueWidth: ValueWidth): CachedJitAvailability {
    const local = this.#allocLocal();
    const availability = {
      entry,
      pathKey: this.#currentPathKey,
      local,
      valueWidth
    };
    const oldAvailability = entry.availabilitiesByPath.get(this.#currentPathKey);

    if (oldAvailability !== undefined) {
      this.#removeAvailability(oldAvailability);
    }

    local.availability = availability;
    entry.availabilitiesByPath.set(this.#currentPathKey, availability);
    this.#currentPathFrame()?.createdAvailabilities.add(availability);
    return availability;
  }

  #allocLocal(): CachedJitLocal {
    const cacheLocal = this.#freeLocals.pop() ?? {
      local: this.#body.addLocal(wasmValueType.i32),
      ownerCount: 0,
      free: false
    };

    cacheLocal.free = false;
    return cacheLocal;
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

        if (cacheLocal.ownerCount === 0 && cacheLocal.availability === undefined) {
          this.#freeLocal(cacheLocal);
        }
      }
    };
  }

  #clearAvailabilities(entry: CachedJitValue): void {
    for (const availability of entry.availabilitiesByPath.values()) {
      this.#removeAvailability(availability);
    }

    entry.availabilitiesByPath.clear();
  }

  #removeAvailability(availability: CachedJitAvailability): void {
    if (availability.entry.availabilitiesByPath.get(availability.pathKey) === availability) {
      availability.entry.availabilitiesByPath.delete(availability.pathKey);
    }

    if (availability.local.availability !== availability) {
      return;
    }

    availability.local.availability = undefined;

    if (availability.local.ownerCount === 0) {
      this.#freeLocal(availability.local);
    }
  }

  #currentPathFrame(): JitPathFrame | undefined {
    return this.#pathStack[this.#pathStack.length - 1];
  }

  #freeLocal(cacheLocal: CachedJitLocal): void {
    if (!cacheLocal.free) {
      cacheLocal.free = true;
      this.#freeLocals.push(cacheLocal);
    }
  }
}

export function createJitValueCacheRuntime(
  body: WasmFunctionBodyEncoder,
  plan: JitValueCachePlan | undefined
): JitValueCacheRuntime | undefined {
  if (plan === undefined || plan.useCounts.length === 0) {
    return undefined;
  }

  const cachePlan = plan;
  const store = new JitValueLocalStore(body, cachePlan.useCounts);
  let currentEpoch = 0;
  let currentInstructionIndex = 0;

  return {
    beginInstruction: (index) => {
      if (index < 0 || index >= cachePlan.instructions.length) {
        throw new Error(`JIT value cache instruction index out of range: ${index}`);
      }

      currentInstructionIndex = index;
      currentEpoch = currentInstructionPlan().opEpochs[0] ?? currentEpoch;
    },
    beginExpressionOp: (opIndex) => {
      const instructionPlan = currentInstructionPlan();

      if (opIndex < 0 || opIndex >= instructionPlan.opEpochs.length) {
        throw new Error(`JIT value cache expression op index out of range: ${opIndex}`);
      }

      currentEpoch = instructionPlan.opEpochs[opIndex] ?? currentEpoch;
    },
    emitForUse: (value, emitter) => {
      if (valueRequiresCacheAtCurrentEpoch(value)) {
        return store.emitForUseWithLocal(value, emitter);
      }

      return store.emitAvailableForUse(value) ?? { valueWidth: emitter() };
    },
    captureForReuse: (value, emitter) =>
      valueRequiresCacheAtCurrentEpoch(value)
        ? store.captureForReuse(value, emitter)
        : store.captureAvailableForReuse(value),
    canEmitInline: (value) => !valueRequiresCacheAtCurrentEpoch(value),
    enterPath: (path) => {
      store.enterPath(path);
    },
    leavePath: () => {
      store.leavePath();
    }
  };

  function valueRequiresCacheAtCurrentEpoch(value: JitValue): boolean {
    return valueIsSelected(cachePlan.consumers[currentEpoch] ?? [], value) ||
      valueIsCaptureSelected(cachePlan.definitionCaptures[currentEpoch] ?? [], value);
  }

  function currentInstructionPlan() {
    const instructionPlan = cachePlan.instructions[currentInstructionIndex];

    if (instructionPlan === undefined) {
      throw new Error(`missing JIT value cache instruction plan: ${currentInstructionIndex}`);
    }

    return instructionPlan;
  }
}

function valuePathKey(path: Path): string {
  return `path:${path.id}`;
}

function rootPathKey(): string {
  return `path:${rootPathId()}`;
}

function valueIsSelected(selected: readonly JitValueUseCount[], value: JitValue): boolean {
  const simplified = simplifyValue(value);

  return selected.some((entry) => valuesEqual(simplifyValue(entry.value), simplified));
}

function valueIsCaptureSelected(selected: readonly JitValue[], value: JitValue): boolean {
  const simplified = simplifyValue(value);

  return selected.some((entry) => valuesEqual(simplifyValue(entry), simplified));
}
