import { wasmValueType } from "#backends/wasm/encoder/types.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { ValueWidth } from "#backends/wasm/codegen/value-width.js";
import { valueKey } from "#backends/wasm/jit/ir/values/keys.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  type SelectedValue
} from "#backends/wasm/jit/codegen/plan/cache.js";
import {
  rootPathId,
  type Path
} from "#backends/wasm/jit/analysis/paths.js";

export type { SelectedValue } from "#backends/wasm/jit/codegen/plan/cache.js";

export type CachedValueUse = Readonly<{
  valueWidth: ValueWidth;
  local?: number;
}>;

export type CachedValueHandle = Readonly<{
  local: number;
  valueWidth: ValueWidth;
  retain(): CachedValueHandle;
  release(): void;
}>;
export type CachedValueLocal = CachedValueHandle & Readonly<{
  emitted: boolean;
}>;

type CachedValueEntry = {
  readonly value: JitValue;
  readonly availabilitiesByPath: Map<string, CachedAvailability>;
};

type CachedAvailability = {
  entry: CachedValueEntry;
  pathKey: string;
  local: CacheLocal;
  valueWidth: ValueWidth;
};

type CacheLocal = {
  local: number;
  ownerCount: number;
  availability?: CachedAvailability | undefined;
  free: boolean;
};

type PathFrame = {
  previousPathKey: string;
  pathKey: string;
  clearCreatedAvailabilitiesOnLeave: boolean;
  createdAvailabilities: Set<CachedAvailability>;
};

export class LocalStore {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #entries = new Map<string, CachedValueEntry>();
  readonly #freeLocals: CacheLocal[] = [];
  #currentPathKey = rootPathKey();
  readonly #pathStack: PathFrame[] = [];

  constructor(body: WasmFunctionBodyEncoder, selectedValues: readonly SelectedValue[]) {
    this.#body = body;

    for (const selected of selectedValues) {
      const value = simplifyValue(selected.value);

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

  emitForUseWithLocal(value: JitValue, emitter: () => ValueWidth): CachedValueUse {
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
  captureForReuse(value: JitValue, emitter: () => ValueWidth): CachedValueLocal | undefined {
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

  emitAvailableForUse(value: JitValue): CachedValueUse | undefined {
    const entry = this.#entryFor(value);
    const availability = entry === undefined ? undefined : this.#visibleAvailability(entry);

    if (availability === undefined) {
      return undefined;
    }

    this.#body.localGet(availability.local.local);
    return { valueWidth: availability.valueWidth, local: availability.local.local };
  }

  captureAvailableForReuse(value: JitValue): CachedValueLocal | undefined {
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

  #entryFor(value: JitValue): CachedValueEntry | undefined {
    const simplified = simplifyValue(value);
    const entry = this.#entries.get(valueKey(simplified));

    return entry !== undefined && valuesEqual(entry.value, simplified) ? entry : undefined;
  }

  #visibleAvailability(entry: CachedValueEntry): CachedAvailability | undefined {
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

  #availabilityForCurrentPath(entry: CachedValueEntry, valueWidth: ValueWidth): CachedAvailability {
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

  #allocLocal(): CacheLocal {
    const cacheLocal = this.#freeLocals.pop() ?? {
      local: this.#body.addLocal(wasmValueType.i32),
      ownerCount: 0,
      free: false
    };

    cacheLocal.free = false;
    return cacheLocal;
  }

  #handleForLocal(cacheLocal: CacheLocal, valueWidth: ValueWidth): CachedValueHandle {
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

  #clearAvailabilities(entry: CachedValueEntry): void {
    for (const availability of entry.availabilitiesByPath.values()) {
      this.#removeAvailability(availability);
    }

    entry.availabilitiesByPath.clear();
  }

  #removeAvailability(availability: CachedAvailability): void {
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

  #freeLocal(cacheLocal: CacheLocal): void {
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
