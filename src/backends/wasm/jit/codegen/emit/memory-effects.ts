import {
  cleanValueWidth,
  emitCleanValueForFullUse,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import {
  emitWasmIrGuardGuestRange,
  emitWasmIrLoadGuestUnchecked,
  emitWasmIrStoreGuestUnchecked
} from "#backends/wasm/codegen/memory.js";
import {
  emitWasmIrExitFromI32Stack
} from "#backends/wasm/codegen/exit.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { ExitReason } from "#backends/wasm/exit.js";
import type {
  Effect
} from "#backends/wasm/jit/codegen/plan/effect-types.js";
import type { ValueCache } from "./cache.js";
import type { ExitFrame } from "./exit-frame.js";
import type {
  ValueEmitOptions,
  ValueEmitter
} from "./values.js";

export type MemoryGuardEffect = Extract<Effect, { kind: "memoryGuard" }>;
export type MemoryStoreEffect = Extract<Effect, { kind: "memoryStore" }>;
export type MemoryLoadEffect = Extract<Effect, { kind: "memoryLoad" }>;
export type MemoryEffect = MemoryGuardEffect | MemoryStoreEffect | MemoryLoadEffect;

export type MemoryEffectsEmitter = Readonly<{
  emit(effect: MemoryEffect): void;
}>;

export type MemoryEffectsInput = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  values: ValueEmitter;
  exitFrame: ExitFrame;
  valueCache?: ValueCache | undefined;
}>;

export function createMemoryEffectsEmitter(
  input: MemoryEffectsInput
): MemoryEffectsEmitter {
  return {
    emit: (effect) => emitMemoryEffect(input, effect)
  };
}

function emitMemoryEffect(
  input: MemoryEffectsInput,
  effect: MemoryEffect
): void {
  switch (effect.kind) {
    case "memoryGuard":
      emitGuard(input, effect);
      return;
    case "memoryStore":
      emitStore(input, effect);
      return;
    case "memoryLoad":
      emitMemoryLoad(input, effect);
      return;
  }
}

function emitGuard(
  input: MemoryEffectsInput,
  effect: MemoryGuardEffect
): void {
  assertMemoryGuardExitMatchesAccess(effect);

  const addressLocal = input.scratch.allocLocal(wasmValueType.i32);

  try {
    emitEffectValue(input, effect.address, { requestedWidth: 32 });
    input.body.localSet(addressLocal);

    const destination = captureMemoryFaultDestination(input, effect);

    emitWasmIrGuardGuestRange(
      {
        body: input.body,
        emitFaultExit: (fault) => {
          input.exitFrame.emitMetadata(effect.exit);
          emitWasmIrExitFromI32Stack(input.body, {
            destination,
            reason: effect.exit.reason,
            extraDepth: fault.extraDepth,
            detail: fault.byteLength
          });
        }
      },
      addressLocal,
      effect.byteLength
    );
  } finally {
    input.scratch.freeLocal(addressLocal);
  }
}

function emitStore(
  input: MemoryEffectsInput,
  effect: MemoryStoreEffect
): void {
  emitWasmIrStoreGuestUnchecked(
    input.body,
    () => {
      emitEffectValue(input, effect.address, { requestedWidth: 32 });
    },
    () => {
      const valueWidth = emitEffectValue(input, effect.value);

      if (effect.width === 32) {
        emitCleanValueForFullUse(input.body, valueWidth);
      }
    },
    effect.width
  );
}

function emitMemoryLoad(
  input: MemoryEffectsInput,
  effect: MemoryLoadEffect
): void {
  const captured = input.valueCache?.capture(effect.result, () => {
    emitWasmIrLoadGuestUnchecked(
      input.body,
      () => {
        emitEffectValue(input, effect.address, { requestedWidth: 32 });
      },
      effect.width,
      effect.signed
    );

    return signedLoadValueWidth(effect.width, effect.signed);
  });

  captured?.release();
}

function signedLoadValueWidth(width: 8 | 16 | 32, signed: boolean): ValueWidth {
  if (signed && width < 32) {
    return cleanValueWidth(32);
  }

  return cleanValueWidth(width);
}

function emitEffectValue(
  input: MemoryEffectsInput,
  value: Parameters<ValueEmitter["emit"]>[0],
  options: ValueEmitOptions = {}
): ValueWidth {
  return input.values.emit(value, options);
}

function captureMemoryFaultDestination(
  input: MemoryEffectsInput,
  effect: MemoryGuardEffect
): ReturnType<ExitFrame["captureDestination"]> {
  assertRuntimeMemoryAddressPayload(effect);
  input.valueCache?.enterPath(effect.exit.path);

  try {
    return input.exitFrame.captureDestination(effect.exit);
  } finally {
    input.valueCache?.leavePath();
  }
}

function assertMemoryGuardExitMatchesAccess(effect: MemoryGuardEffect): void {
  const expected = effect.access === "read"
    ? ExitReason.MEMORY_READ_FAULT
    : ExitReason.MEMORY_WRITE_FAULT;

  if (effect.exit.reason !== expected) {
    throw new Error(`JIT memory ${effect.access} guard received exit reason ${effect.exit.reason}`);
  }
}

function assertRuntimeMemoryAddressPayload(effect: MemoryGuardEffect): void {
  if (effect.exit.payload.kind !== "runtime" || effect.exit.payload.source !== "memoryAddress") {
    throw new Error(`JIT memory ${effect.access} guard requires runtime memoryAddress payload`);
  }
}
