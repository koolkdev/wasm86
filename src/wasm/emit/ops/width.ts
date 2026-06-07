import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { widthMask, type OperandWidth } from "#x86/types.js";

export function emitMaskI32ToWidth(body: WasmFunctionBodyEncoder, width: OperandWidth): void {
  if (width === 32) {
    return;
  }

  body.i32Const(widthMask(width)).i32And();
}

export function emitSignExtendI32ToWidth(body: WasmFunctionBodyEncoder, width: OperandWidth): void {
  switch (width) {
    case 8:
      body.i32Extend8S();
      return;
    case 16:
      body.i32Extend16S();
      return;
    case 32:
      return;
  }
}

export function emitI32Boolean(body: WasmFunctionBodyEncoder): void {
  body.i32Eqz().i32Eqz();
}
