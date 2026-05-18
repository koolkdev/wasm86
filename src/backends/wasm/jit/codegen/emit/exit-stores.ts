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
import type { ValueCapture, ValueEmitter } from "./values.js";
import {
  jitRegisterSlotAlias
} from "#backends/wasm/jit/ir/values/slots.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type {
  JitArchitecturalSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";

export type CapturedExitStore = Readonly<{
  store: PlannedExitStore;
  source?: CapturedExitStoreSource;
}>;

export type CapturedExitStores = Readonly<{
  values: ValueEmitter;
  stores: readonly CapturedExitStore[];
}>;

export type ExitStoreEmitter = Readonly<{
  captureSources(values: ValueEmitter, stores: readonly PlannedExitStore[]): CapturedExitStores;
  emitStores(stores: CapturedExitStores): void;
  release(stores: CapturedExitStores): void;
}>;

type CapturedExitStoreSource = Readonly<{
  kind: "capture";
  value: ValueCapture;
}>;

export type JitExitStoreEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
}>;

export type JitExitStoreCaptureContext = JitExitStoreEmitContext;

export function createExitStoreEmitter(
  context: JitExitStoreCaptureContext
): ExitStoreEmitter {
  return {
    captureSources: (values, stores) => captureExitStores(values, stores),
    emitStores: (stores) => emitExitStores(context, stores),
    release: (stores) => releaseExitStores(stores)
  };
}

export function captureExitStores(
  values: ValueEmitter,
  stores: readonly PlannedExitStore[]
): CapturedExitStores {
  return {
    values,
    stores: stores.map((store) => captureJitExitStore(values, store))
  };
}

export function emitExitStores(
  context: JitExitStoreEmitContext,
  captured: CapturedExitStores
): void {
  for (const store of captured.stores) {
    emitJitExitStore(context, captured.values, store);
  }
}

export function releaseExitStores(
  captured: CapturedExitStores
): void {
  for (const store of captured.stores) {
    if (store.source?.kind === "capture") {
      store.source.value.release();
    }
  }
}

function captureJitExitStore(
  values: ValueEmitter,
  store: PlannedExitStore
): CapturedExitStore {
  const captured = captureExitStoreSource(values, store);

  if (captured !== undefined) {
    return capturedExitStore(store, captured);
  }

  if (store.source.kind === "capture") {
    throw new Error("JIT exit-store source capture was not available in the value cache");
  }

  const simplified = simplifyValue(store.store.value);

  if (simplified.kind === "produced") {
    throw new Error("JIT produced exit store value was not captured before exit store emission");
  }

  return { store };
}

function captureExitStoreSource(
  values: ValueEmitter,
  store: PlannedExitStore
): ValueCapture | undefined {
  switch (store.source.kind) {
    case "capture": {
      const { capture } = store.source;

      return values.capture(
        capture,
        () => emitJitExitStoreSourceValue(values, capture.value, false, false)
      );
    }
    case "inline": {
      return values.retain(store.store.value);
    }
  }
}

function capturedExitStore(
  store: PlannedExitStore,
  captured: ValueCapture
): CapturedExitStore {
  return {
    store,
    source: {
      kind: "capture",
      value: captured
    }
  };
}

function emitJitExitStore(
  context: JitExitStoreEmitContext,
  values: ValueEmitter,
  capturedStore: CapturedExitStore
): void {
  const { target, value } = capturedStore.store.store;

  emitJitStoreTarget(context.body, target, () => emitCapturedOrInlineStoreSource(
    context,
    values,
    value,
    capturedStore.source,
    target
  ));
}

function emitCapturedOrInlineStoreSource(
  context: JitExitStoreEmitContext,
  values: ValueEmitter,
  value: JitValue,
  source: CapturedExitStoreSource | undefined,
  target: JitArchitecturalSlot
): ValueWidth {
  if (source !== undefined) {
    const valueWidth = source.value.emit();

    return storeTargetUsesFullWidthValue(target)
      ? emitCleanValueForFullUse(context.body, valueWidth)
      : valueWidth;
  }

  return emitJitExitStoreSourceValue(
    values,
    value,
    storeTargetUsesFullWidthValue(target)
  );
}

function storeTargetUsesFullWidthValue(target: JitArchitecturalSlot): boolean {
  return target.kind === "reg32" || target.kind === "aluFlags";
}

function emitJitExitStoreSourceValue(
  values: ValueEmitter,
  value: JitValue,
  requireFullWidth = false,
  cacheRoot = true
): ValueWidth {
  const emit = cacheRoot ? values.emit : values.emitInline;

  return emit(value, requireFullWidth ? { requestedWidth: 32 } : {});
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
