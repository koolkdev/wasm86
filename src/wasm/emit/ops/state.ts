import { wasmMemoryIndex } from "#wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmMemoryImmediate } from "#wasm/encoder/memory.js";
import type { OperandWidth } from "#x86/types.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "../values/types.js";
import {
  emitI32Load,
  emitI32Store
} from "./memory.js";

export type WasmStateValueProducer = () => WasmEmittedValue;

export function emitLoadStateI32(
  body: WasmFunctionBodyEncoder,
  offset: number,
  width: OperandWidth,
  signed = false
): WasmEmittedValue {
  body.i32Const(0);
  emitI32Load(body, stateImmediate(offset, width), width, signed);
  return wasmI32(signed ? 32 : width);
}

export function emitStoreStateI32(
  body: WasmFunctionBodyEncoder,
  offset: number,
  width: OperandWidth,
  emitValue: WasmStateValueProducer
): void {
  body.i32Const(0);
  emitValue();
  emitI32Store(body, stateImmediate(offset, width), width);
}

export function stateImmediate(offset: number, width: OperandWidth): WasmMemoryImmediate {
  return {
    align: stateAlign(offset, width),
    memoryIndex: wasmMemoryIndex.state,
    offset
  };
}

function stateAlign(offset: number, width: OperandWidth): 0 | 1 | 2 {
  switch (width) {
    case 8:
      return 0;
    case 16:
      return offset % 2 === 0 ? 1 : 0;
    case 32:
      return 2;
  }
}
