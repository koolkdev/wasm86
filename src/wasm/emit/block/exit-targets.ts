import type { BlockExit } from "#ir/block/exits.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  encodeExit,
  type ExitReason as ExitReasonValue
} from "#wasm/exit.js";

export type WasmExitTargetInput = Readonly<{
  exit: BlockExit;
  reason: ExitReasonValue;
  controlDepth: number;
  detail?: number;
}>;

export type WasmExitConstantTargetInput = WasmExitTargetInput & Readonly<{
  payload: number;
}>;

export type WasmExitTarget = Readonly<{
  emitStackPayload(input: WasmExitTargetInput): void;
  emitConstantPayload(input: WasmExitConstantTargetInput): void;
}>;

export type WasmLocalExitDestination = Readonly<{
  exitLocal: number;
  labelDepth: number;
}>;

export function createWasmReturnExitTarget(body: WasmFunctionBodyEncoder): WasmExitTarget {
  return {
    emitStackPayload: (input) => {
      emitEncodedExitFromStack(body, input);
      body.returnFromFunction();
    },
    emitConstantPayload: (input) => {
      body
        .i64Const(encodeExit(input.reason, input.payload, input.detail))
        .returnFromFunction();
    }
  };
}

export function createWasmLocalExitTarget(input: Readonly<{
  body: WasmFunctionBodyEncoder;
  destination(exit: BlockExit): WasmLocalExitDestination;
}>): WasmExitTarget {
  return {
    emitStackPayload: (exit) => {
      const destination = input.destination(exit.exit);

      emitEncodedExitFromStack(input.body, exit);
      input.body.localSet(destination.exitLocal);
      input.body.br(destination.labelDepth + exit.controlDepth);
    },
    emitConstantPayload: (exit) => {
      const destination = input.destination(exit.exit);

      input.body.i64Const(encodeExit(exit.reason, exit.payload, exit.detail)).localSet(destination.exitLocal);
      input.body.br(destination.labelDepth + exit.controlDepth);
    }
  };
}

function emitEncodedExitFromStack(
  body: WasmFunctionBodyEncoder,
  input: WasmExitTargetInput
): void {
  body
    .i64ExtendI32U()
    .i64Const(encodeExit(input.reason, 0, input.detail))
    .i64Or();
}
