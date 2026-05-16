import { stateOffset } from "#backends/wasm/abi.js";
import {
  emitStoreStateU16,
  emitStoreStateU32,
  emitStoreStateU8
} from "#backends/wasm/codegen/state.js";
import {
  emitCleanValueForFullUse,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { PlannedExitStore } from "#backends/wasm/jit/codegen/plan/types.js";
import {
  createValueEmitter,
  unavailableProducedEmitter,
  type ValueEmitter
} from "./values.js";
import type {
  CachedHandle,
  ValueCache
} from "./cache.js";
import {
  jitRegisterSlotAlias
} from "#backends/wasm/jit/ir/values/slots.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type {
  JitArchitecturalSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import { createInputSlotEmitter } from "./input-slots.js";

export type CapturedExitStore = Readonly<{
  store: PlannedExitStore;
  source?: CapturedExitStoreSource;
}>;

export type CapturedExitStores = readonly CapturedExitStore[];

export type ExitStoreEmitter = Readonly<{
  captureSources(stores: readonly PlannedExitStore[]): CapturedExitStores;
  emitStores(stores: CapturedExitStores): void;
  release(stores: CapturedExitStores): void;
}>;

type CapturedExitStoreSource = Readonly<{
  kind: "cache";
  local: number;
  valueWidth: ValueWidth;
  owner: CachedHandle;
}>;

export type JitExitStoreEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  valueCache?: ValueCache | undefined;
}>;

export function createExitStoreEmitter(
  context: JitExitStoreEmitContext
): ExitStoreEmitter {
  return {
    captureSources: (stores) => captureExitStores(context, stores),
    emitStores: (stores) => emitExitStores(context, stores),
    release: (stores) => releaseExitStores(stores)
  };
}

export function captureExitStores(
  context: JitExitStoreEmitContext,
  stores: readonly PlannedExitStore[]
): CapturedExitStores {
  return stores.map((store) => captureJitExitStore(context, store));
}

export function emitExitStores(
  context: JitExitStoreEmitContext,
  stores: readonly CapturedExitStore[]
): void {
  for (const store of stores) {
    emitJitExitStore(context, store);
  }
}

export function releaseExitStores(
  stores: readonly CapturedExitStore[]
): void {
  for (const store of stores) {
    if (store.source?.kind === "cache") {
      store.source.owner.release();
    }
  }
}

function captureJitExitStore(
  context: JitExitStoreEmitContext,
  store: PlannedExitStore
): CapturedExitStore {
  const { value } = store.store;
  const captured = context.valueCache?.capture(
    store.source.kind === "capture" ? store.source.capture.value : value,
    () => emitJitExitStoreSourceValue(context, value, false, false)
  );

  if (captured !== undefined) {
    return {
      store,
      source: {
        kind: "cache",
        local: captured.local,
        valueWidth: captured.valueWidth,
        owner: captured
      }
    };
  }

  if (store.source.kind === "inline") {
    const simplified = simplifyValue(value);

    if (simplified.kind === "produced") {
      throw new Error("JIT produced exit store value was not captured before exit store emission");
    }

    return { store };
  }

  throw new Error("JIT exit-store source capture was not available in the value cache");
}

function emitJitExitStore(
  context: JitExitStoreEmitContext,
  capturedStore: CapturedExitStore
): void {
  const { target, value } = capturedStore.store.store;

  emitJitStoreTarget(context.body, target, () => emitCapturedOrInlineStoreSource(
    context,
    value,
    capturedStore.source,
    target
  ));
}

function emitCapturedOrInlineStoreSource(
  context: JitExitStoreEmitContext,
  value: JitValue,
  source: CapturedExitStoreSource | undefined,
  target: JitArchitecturalSlot
): ValueWidth {
  if (source !== undefined) {
    context.body.localGet(source.local);

    return storeTargetUsesFullWidthValue(target)
      ? emitCleanValueForFullUse(context.body, source.valueWidth)
      : source.valueWidth;
  }

  return emitJitExitStoreSourceValue(
    context,
    value,
    storeTargetUsesFullWidthValue(target)
  );
}

function storeTargetUsesFullWidthValue(target: JitArchitecturalSlot): boolean {
  return target.kind === "reg32" || target.kind === "aluFlags";
}

function emitJitExitStoreSourceValue(
  context: JitExitStoreEmitContext,
  value: JitValue,
  requireFullWidth = false,
  cacheRoot = true
): ValueWidth {
  const values = createExitStoreValueEmitter(context);
  const emit = cacheRoot ? values.emit : values.emitInline;

  return emit(value, requireFullWidth ? { requestedWidth: 32 } : {});
}

function createExitStoreValueEmitter(context: JitExitStoreEmitContext): ValueEmitter {
  return createValueEmitter({
    body: context.body,
    cache: context.valueCache,
    inputs: createInputSlotEmitter(context.body),
    produced: unavailableProducedEmitter()
  });
}

function emitJitStoreTarget(
  body: WasmFunctionBodyEncoder,
  target: JitArchitecturalSlot,
  emitValue: () => void
): void {
  switch (target.kind) {
    case "reg32":
      emitStoreStateU32(body, stateOffset[target.reg], emitValue);
      return;
    case "reg16": {
      const alias = jitRegisterSlotAlias(target);

      emitStoreStateU16(body, stateOffset[alias.base] + alias.bitOffset / 8, emitValue);
      return;
    }
    case "reg8": {
      const alias = jitRegisterSlotAlias(target);

      emitStoreStateU8(body, stateOffset[alias.base] + alias.bitOffset / 8, emitValue);
      return;
    }
    case "aluFlags":
      emitStoreStateU32(body, stateOffset.aluFlags, emitValue);
      return;
  }
}
