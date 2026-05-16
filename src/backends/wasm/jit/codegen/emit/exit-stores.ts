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
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import type {
  ExitStore,
  StoreTarget
} from "#backends/wasm/jit/codegen/plan/types.js";
import { emitJitValue } from "./jit-values.js";
import type {
  JitCachedValueHandle,
  JitValueCacheRuntime
} from "./value-local-store.js";
import { slotsReadByValueForMask } from "#backends/wasm/jit/ir/values/slots.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type {
  JitArchitecturalSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import { emitJitInputSlot, emitJitInputSlotBits } from "./input-slots.js";

export type CapturedExitStore = Readonly<{
  store: ExitStore;
  source?: CapturedExitStoreSource;
}>;

type CapturedExitStoreSource = Readonly<{
  kind: "cache";
  local: number;
  valueWidth: ValueWidth;
  owner: JitCachedValueHandle;
}> | Readonly<{
  kind: "temporary";
  local: number;
  valueWidth: ValueWidth;
}>;

export type JitExitStoreEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  valueCache?: JitValueCacheRuntime | undefined;
}>;

export function captureExitStores(
  context: JitExitStoreEmitContext,
  stores: readonly ExitStore[]
): readonly CapturedExitStore[] | undefined {
  if (stores.length === 0) {
    return undefined;
  }

  const previousTargets: StoreTarget[] = [];

  return stores.map((store) => {
    const captured = captureJitExitStore(context, store, previousTargets);

    previousTargets.push(store.target);
    return captured;
  });
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
  store: ExitStore,
  previousTargets: readonly StoreTarget[]
): CapturedExitStore {
  const captured = context.valueCache?.captureForReuse(
    store.value,
    () => emitJitExitStoreSourceValue(context, store.value)
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

  const value = simplifyValue(store.value);

  if (value.kind === "const") {
    return { store };
  }

  if (value.kind === "produced") {
    throw new Error("JIT produced exit store value was not captured before exit store emission");
  }

  if (!exitStoreSourceNeedsTemporaryLocal(value, previousTargets)) {
    return { store };
  }

  const local = context.body.addLocal(wasmValueType.i32);
  const valueWidth = emitJitExitStoreSourceValue(context, value);

  context.body.localSet(local);
  return {
    store,
    source: {
      kind: "temporary",
      local,
      valueWidth
    }
  };
}

function exitStoreSourceNeedsTemporaryLocal(
  value: JitValue,
  previousTargets: readonly StoreTarget[]
): boolean {
  if (previousTargets.length === 0) {
    return false;
  }

  const sourceSlots = slotsReadByValueForMask(value, 0xffff_ffff);

  return previousTargets.some((target) => {
    const targetSlot = storeTargetSlot(target);

    return targetSlot !== undefined && sourceSlots.some((slot) =>
      jitArchitecturalSlotsEqual(slot, targetSlot)
    );
  });
}

function storeTargetSlot(target: StoreTarget): JitArchitecturalSlot | undefined {
  switch (target.kind) {
    case "reg32":
      return { kind: "reg32", reg: target.reg };
    case "regPart":
      return { kind: "reg32", reg: target.reg };
    case "aluFlags":
      return { kind: "aluFlags" };
  }
}

function jitArchitecturalSlotsEqual(left: JitArchitecturalSlot, right: JitArchitecturalSlot): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "reg32":
      return right.kind === "reg32" && left.reg === right.reg;
    case "aluFlags":
      return true;
  }
}

function emitJitExitStore(
  context: JitExitStoreEmitContext,
  capturedStore: CapturedExitStore
): void {
  const { target, value } = capturedStore.store;

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
  target: StoreTarget
): ValueWidth {
  if (source !== undefined) {
    context.body.localGet(source.local);

    return target.kind === "reg32" || target.kind === "aluFlags"
      ? emitCleanValueForFullUse(context.body, source.valueWidth)
      : source.valueWidth;
  }

  return emitJitExitStoreSourceValue(
    context,
    value,
    target.kind === "reg32" || target.kind === "aluFlags"
  );
}

function emitJitExitStoreSourceValue(
  context: JitExitStoreEmitContext,
  value: JitValue,
  requireFullWidth = false
): ValueWidth {
  return emitJitValue({
    body: context.body,
    valueCache: context.valueCache,
    emitInput: (slot) => emitJitInputSlot(context.body, slot),
    emitInputBits: (slot, bitOffset, width, signed) =>
      emitJitInputSlotBits(context.body, slot, bitOffset, width, signed)
  }, value, requireFullWidth ? { requestedWidth: 32 } : {});
}

function emitJitStoreTarget(
  body: WasmFunctionBodyEncoder,
  target: StoreTarget,
  emitValue: () => void
): void {
  switch (target.kind) {
    case "reg32":
      emitStoreStateU32(body, stateOffset[target.reg], emitValue);
      return;
    case "regPart": {
      const offset = stateOffset[target.reg] + target.bitOffset / 8;

      switch (target.width) {
        case 8:
          emitStoreStateU8(body, offset, emitValue);
          return;
        case 16:
          emitStoreStateU16(body, offset, emitValue);
          return;
        case 32:
          throw new Error("JIT regPart exit stores cannot use 32-bit width");
      }
    }
    case "aluFlags":
      emitStoreStateU32(body, stateOffset.aluFlags, emitValue);
      return;
  }
}
