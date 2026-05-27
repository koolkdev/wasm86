import { wasmValueType } from "#wasm/encoder/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { ValueWidth } from "#wasm/codegen/value-width.js";
import { valueKey } from "#backends/wasm/jit/ir/values/keys.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  rootPathId,
  type Path
} from "#backends/wasm/jit/analysis/paths.js";

export type CachedUse = Readonly<{
  valueWidth: ValueWidth;
  local?: number;
}>;

export type CachedHandle = Readonly<{
  local: number;
  valueWidth: ValueWidth;
  retain(): CachedHandle;
  release(): void;
}>;
export type CapturedValue = CachedHandle & Readonly<{
  emitted: boolean;
}>;

type CacheEntry = {
  readonly value: JitValue;
  readonly availabilitiesByPath: Map<string, Availability>;
};

type Availability = {
  entry: CacheEntry;
  pathKey: string;
  local: LocalSlot;
  valueWidth: ValueWidth;
};

type LocalSlot = {
  local: number;
  ownerCount: number;
  availability?: Availability | undefined;
  free: boolean;
};

type PathFrame = {
  previousPathKey: string;
  pathKey: string;
  clearCreatedAvailabilitiesOnLeave: boolean;
  createdAvailabilities: Set<Availability>;
};

export class LocalStore {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #freeLocals: LocalSlot[] = [];
  #currentPathKey = rootPathKey();
  readonly #pathStack: PathFrame[] = [];

  constructor(body: WasmFunctionBodyEncoder) {
    this.#body = body;
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

  withPath<T>(path: Path, emit: () => T): T {
    if (this.isCurrentPath(path)) {
      return emit();
    }

    this.enterPath(path);

    try {
      return emit();
    } finally {
      this.leavePath();
    }
  }

  isCurrentPath(path: Path): boolean {
    return this.#currentPathKey === valuePathKey(path);
  }

  get(value: JitValue): CachedUse | undefined {
    const availability = this.#visibleAvailabilityForValue(value);

    if (availability !== undefined) {
      this.#body.localGet(availability.local.local);
      return { valueWidth: availability.valueWidth, local: availability.local.local };
    }

    return undefined;
  }

  tee(value: JitValue, valueWidth: ValueWidth): CachedUse {
    const newAvailability = this.#availabilityForCurrentPath(value, valueWidth);
    this.#body.localTee(newAvailability.local.local);
    return { valueWidth, local: newAvailability.local.local };
  }

  set(value: JitValue, valueWidth: ValueWidth): CapturedValue {
    const newAvailability = this.#availabilityForCurrentPath(value, valueWidth);
    this.#body.localSet(newAvailability.local.local);
    return {
      ...this.#handleForLocal(newAvailability.local, valueWidth),
      valueWidth,
      emitted: true
    };
  }

  retainAvailable(value: JitValue): CapturedValue | undefined {
    const availability = this.#visibleAvailabilityForValue(value);

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

  #entryFor(value: JitValue): CacheEntry | undefined {
    const simplified = simplifyValue(value);
    const entry = this.#entries.get(valueKey(simplified));

    return entry !== undefined && valuesEqual(entry.value, simplified) ? entry : undefined;
  }

  #entryForStore(value: JitValue): CacheEntry {
    const simplified = simplifyValue(value);
    const key = valueKey(simplified);
    const existing = this.#entries.get(key);

    if (existing !== undefined) {
      if (!valuesEqual(existing.value, simplified)) {
        throw new Error("JIT value cache key collision for non-equal values");
      }

      return existing;
    }

    const entry = {
      value: simplified,
      availabilitiesByPath: new Map()
    };

    this.#entries.set(key, entry);
    return entry;
  }

  #visibleAvailabilityForValue(value: JitValue): Availability | undefined {
    const entry = this.#entryFor(value);

    return entry === undefined ? undefined : this.#visibleAvailability(entry);
  }

  #visibleAvailability(entry: CacheEntry): Availability | undefined {
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

  #availabilityForCurrentPath(value: JitValue, valueWidth: ValueWidth): Availability {
    const entry = this.#entryForStore(value);
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

  #allocLocal(): LocalSlot {
    const cacheLocal = this.#freeLocals.pop() ?? {
      local: this.#body.addLocal(wasmValueType.i32),
      ownerCount: 0,
      free: false
    };

    cacheLocal.free = false;
    return cacheLocal;
  }

  #handleForLocal(cacheLocal: LocalSlot, valueWidth: ValueWidth): CachedHandle {
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

  #clearAvailabilities(entry: CacheEntry): void {
    for (const availability of entry.availabilitiesByPath.values()) {
      this.#removeAvailability(availability);
    }

    entry.availabilitiesByPath.clear();
  }

  #removeAvailability(availability: Availability): void {
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

  #currentPathFrame(): PathFrame | undefined {
    return this.#pathStack[this.#pathStack.length - 1];
  }

  #freeLocal(cacheLocal: LocalSlot): void {
    if (!cacheLocal.free) {
      cacheLocal.free = true;
      this.#freeLocals.push(cacheLocal);
    }
  }
}

function valuePathKey(path: Path): string {
  return `path:${path.id}`;
}

function rootPathKey(): string {
  return `path:${rootPathId()}`;
}
