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
import type { ExitFrame } from "./exit-frame.js";
import type { ValueEmitter } from "./values.js";

export type MemoryGuardEffect = Extract<Effect, { kind: "memoryGuard" }>;
export type MemoryStoreEffect = Extract<Effect, { kind: "memoryStore" }>;
export type MemoryLoadEffect = Extract<Effect, { kind: "memoryLoad" }>;
export type MemoryEffect = MemoryGuardEffect | MemoryStoreEffect | MemoryLoadEffect;

export type MemoryEffectsEmitter = Readonly<{
  emit(effect: MemoryEffect, values: ValueEmitter): void;
}>;

export type MemoryEffectsInput = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  exitFrame: ExitFrame;
}>;

export function createMemoryEffectsEmitter(
  input: MemoryEffectsInput
): MemoryEffectsEmitter {
  return {
    emit: (effect, values) => emitMemoryEffect(input, effect, values)
  };
}

function emitMemoryEffect(
  input: MemoryEffectsInput,
  effect: MemoryEffect,
  values: ValueEmitter
): void {
  switch (effect.kind) {
    case "memoryGuard":
      emitGuard(input, effect, values);
      return;
    case "memoryStore":
      emitStore(input, effect, values);
      return;
    case "memoryLoad":
      emitMemoryLoad(input, effect, values);
      return;
  }
}

function emitGuard(
  input: MemoryEffectsInput,
  effect: MemoryGuardEffect,
  values: ValueEmitter
): void {
  assertMemoryGuardExitMatchesAccess(effect);

  const addressLocal = input.scratch.allocLocal(wasmValueType.i32);

  try {
    values.emit(effect.address, { requestedWidth: 32 });
    input.body.localSet(addressLocal);

    const destination = captureMemoryFaultDestination(input, effect, values);

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
  effect: MemoryStoreEffect,
  values: ValueEmitter
): void {
  emitWasmIrStoreGuestUnchecked(
    input.body,
    () => {
      values.emit(effect.address, { requestedWidth: 32 });
    },
    () => {
      const valueWidth = values.emit(effect.value);

      if (effect.width === 32) {
        emitCleanValueForFullUse(input.body, valueWidth);
      }
    },
    effect.width
  );
}

function emitMemoryLoad(
  input: MemoryEffectsInput,
  effect: MemoryLoadEffect,
  values: ValueEmitter
): void {
  const captured = values.define(
    effect.result,
    () => {
      emitWasmIrLoadGuestUnchecked(
        input.body,
        () => {
          values.emit(effect.address, { requestedWidth: 32 });
        },
        effect.width,
        effect.signed
      );

      return signedLoadValueWidth(effect.width, effect.signed);
    }
  );

  captured?.release();
}

function signedLoadValueWidth(width: 8 | 16 | 32, signed: boolean): ValueWidth {
  if (signed && width < 32) {
    return cleanValueWidth(32);
  }

  return cleanValueWidth(width);
}

function captureMemoryFaultDestination(
  input: MemoryEffectsInput,
  effect: MemoryGuardEffect,
  values: ValueEmitter
): ReturnType<ExitFrame["captureDestination"]> {
  assertRuntimeMemoryAddressPayload(effect);

  return values.withPath(effect.exit.path, () =>
    input.exitFrame.captureDestination(values, effect.exit)
  );
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
