import { wasmValueType, type WasmValueType } from "#wasm/encoder/types.js";
import type { OperandWidth } from "#x86/types.js";

export type WasmEmittedValue = Readonly<{
  wasmType: "i32";
  width: OperandWidth;
}>;

export function wasmI32(width: OperandWidth): WasmEmittedValue {
  return { wasmType: "i32", width };
}

export function wasmTypeOf(value: WasmEmittedValue): WasmValueType {
  switch (value.wasmType) {
    case "i32":
      return wasmValueType.i32;
  }
}
