import type { ScalarBinaryOp } from "#ir/expr/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { widthMask, type OperandWidth } from "#x86/types.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "./types.js";

export function ensureWidth(
  body: WasmFunctionBodyEncoder,
  value: WasmEmittedValue,
  width: OperandWidth
): WasmEmittedValue {
  if (value.width > width) {
    body.i32Const(widthMask(width)).i32And();
  }

  return wasmI32(width);
}

export function signExtendI32(
  body: WasmFunctionBodyEncoder,
  width: 8 | 16
): WasmEmittedValue {
  switch (width) {
    case 8:
      body.i32Extend8S();
      break;
    case 16:
      body.i32Extend16S();
      break;
  }

  return wasmI32(32);
}

export function binaryResultWidth(
  op: ScalarBinaryOp,
  left: WasmEmittedValue,
  right: WasmEmittedValue
): OperandWidth {
  switch (op) {
    case "add":
      if (left.width === 8 && right.width === 8) {
        return 16;
      }

      if (left.width === 16 && right.width === 16) {
        return 32;
      }

      return 32;
    case "sub":
    case "shl":
      return 32;
    case "or":
    case "xor":
      return maxWidth(left.width, right.width);
    case "and":
      return minWidth(left.width, right.width);
    case "shr_u":
      return left.width;
  }
}

export function constWidth(value: number): OperandWidth {
  const unsigned = value >>> 0;

  if (unsigned <= 0xff) {
    return 8;
  }

  if (unsigned <= 0xffff) {
    return 16;
  }

  return 32;
}

export function maxWidth(left: OperandWidth, right: OperandWidth): OperandWidth {
  return left >= right ? left : right;
}

function minWidth(left: OperandWidth, right: OperandWidth): OperandWidth {
  return left <= right ? left : right;
}
