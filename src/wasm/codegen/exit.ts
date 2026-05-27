import { encodeExit, type ExitReason } from "#wasm/exit.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";

export type WasmIrExitDestination = Readonly<{
  exitLocal: number;
  labelDepth: number;
}>;

export type WasmIrStackExit = Readonly<{
  destination: WasmIrExitDestination;
  reason: ExitReason;
  extraDepth?: number;
  detail?: number;
}>;

export type WasmIrConstPayloadExit = WasmIrStackExit & Readonly<{
  payload: number;
}>;

export function emitWasmIrExitFromI32Stack(
  body: WasmFunctionBodyEncoder,
  exit: WasmIrStackExit
): void {
  const {
    destination,
    reason,
    extraDepth = 0,
    detail = 0
  } = exit;

  body.i64ExtendI32U().i64Const(encodeExit(reason, 0, detail)).i64Or().localSet(destination.exitLocal);
  body.br(destination.labelDepth + extraDepth);
}

export function emitWasmIrExitConstPayload(
  body: WasmFunctionBodyEncoder,
  exit: WasmIrConstPayloadExit
): void {
  const {
    destination,
    reason,
    payload,
    extraDepth = 0,
    detail = 0
  } = exit;

  body.i64Const(encodeExit(reason, payload, detail)).localSet(destination.exitLocal);
  body.br(destination.labelDepth + extraDepth);
}
