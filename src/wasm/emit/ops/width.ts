import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { widthMask, type OperandWidth } from "#x86/types.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "../values/types.js";
import { signExtendI32 } from "../values/width.js";

export function emitMaskI32ToWidth(body: WasmFunctionBodyEncoder, width: OperandWidth): void {
  if (width === 32) {
    return;
  }

  body.i32Const(widthMask(width)).i32And();
}

export function emitSignExtendI32ToWidth(body: WasmFunctionBodyEncoder, width: OperandWidth): void {
  switch (width) {
    case 8:
      signExtendI32(body, 8);
      return;
    case 16:
      signExtendI32(body, 16);
      return;
    case 32:
      return;
  }
}

export function emitI32Boolean(body: WasmFunctionBodyEncoder): WasmEmittedValue {
  body.i32Eqz().i32Eqz();
  return wasmI32(8);
}
