import {
  emitCleanValueForFullUse,
} from "#wasm/codegen/value-width.js";
import {
  emitWasmIrGuardGuestRange,
  emitWasmIrStoreGuestUnchecked
} from "#wasm/codegen/memory.js";
import {
  emitWasmIrExitFromI32Stack
} from "#wasm/codegen/exit.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { ExitReason } from "#wasm/exit.js";
import type {
  MemoryGuardEntry,
  MemoryStoreEntry
} from "#backends/wasm/jit/codegen/plan/schedule-types.js";
import type { ExitFrame } from "./exit-frame.js";
import type { ValueEmitter } from "./values.js";

export type MemoryGuardAction = MemoryGuardEntry;
export type MemoryStoreAction = MemoryStoreEntry;
export type MemoryAction = MemoryGuardAction | MemoryStoreAction;

export type MemoryActionEmitter = Readonly<{
  emit(action: MemoryAction, values: ValueEmitter): void;
}>;

export type MemoryActionInput = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  exitFrame: ExitFrame;
}>;

export function createMemoryActionEmitter(
  input: MemoryActionInput
): MemoryActionEmitter {
  return {
    emit: (action, values) => emitMemoryAction(input, action, values)
  };
}

function emitMemoryAction(
  input: MemoryActionInput,
  action: MemoryAction,
  values: ValueEmitter
): void {
  switch (action.kind) {
    case "memoryGuard":
      emitGuard(input, action, values);
      return;
    case "memoryStore":
      emitStore(input, action, values);
      return;
  }
}

function emitGuard(
  input: MemoryActionInput,
  action: MemoryGuardAction,
  values: ValueEmitter
): void {
  assertMemoryGuardExitMatchesAccess(action);

  const addressLocal = input.scratch.allocLocal(wasmValueType.i32);

  try {
    values.emit(action.address, { requestedWidth: 32 });
    input.body.localSet(addressLocal);

    const destination = captureMemoryFaultDestination(input, action, values);

    emitWasmIrGuardGuestRange(
      {
        body: input.body,
        emitFaultExit: (fault) => {
          input.exitFrame.emitMetadata(action.exit);
          emitWasmIrExitFromI32Stack(input.body, {
            destination,
            reason: action.exit.reason,
            extraDepth: fault.extraDepth,
            detail: fault.byteLength
          });
        }
      },
      addressLocal,
      action.byteLength
    );
  } finally {
    input.scratch.freeLocal(addressLocal);
  }
}

function emitStore(
  input: MemoryActionInput,
  action: MemoryStoreAction,
  values: ValueEmitter
): void {
  emitWasmIrStoreGuestUnchecked(
    input.body,
    () => {
      values.emit(action.address, { requestedWidth: 32 });
    },
    () => {
      const valueWidth = values.emit(action.value);

      if (action.width === 32) {
        emitCleanValueForFullUse(input.body, valueWidth);
      }
    },
    action.width
  );
}

function captureMemoryFaultDestination(
  input: MemoryActionInput,
  action: MemoryGuardAction,
  values: ValueEmitter
): ReturnType<ExitFrame["captureDestination"]> {
  assertRuntimeMemoryAddressPayload(action);

  return values.withPath(action.exit.path, () =>
    input.exitFrame.captureDestination(values, action.exit)
  );
}

function assertMemoryGuardExitMatchesAccess(action: MemoryGuardAction): void {
  const expected = action.access === "read"
    ? ExitReason.MEMORY_READ_FAULT
    : ExitReason.MEMORY_WRITE_FAULT;

  if (action.exit.reason !== expected) {
    throw new Error(`JIT memory ${action.access} guard received exit reason ${action.exit.reason}`);
  }
}

function assertRuntimeMemoryAddressPayload(action: MemoryGuardAction): void {
  if (action.exit.payload.kind !== "runtime" || action.exit.payload.source !== "memoryAddress") {
    throw new Error(`JIT memory ${action.access} guard requires runtime memoryAddress payload`);
  }
}
