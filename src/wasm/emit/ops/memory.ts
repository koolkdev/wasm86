import { assert } from "#common/assert.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import {
  wasmBranchHint,
  type WasmFunctionBodyEncoder
} from "#wasm/encoder/function-body.js";
import type { WasmMemoryImmediate } from "#wasm/encoder/memory.js";
import type { OperandWidth } from "#x86/types.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "../values/types.js";

export type WasmMemoryAddressProducer = () => WasmEmittedValue;
export type WasmMemoryValueProducer = () => WasmEmittedValue;
export type WasmMemoryFaultEmitter = () => void;

const wasmPageShift = 16;

export function wasmMemoryAlignForWidth(width: OperandWidth): 0 | 1 | 2 {
  switch (width) {
    case 8:
      return 0;
    case 16:
      return 1;
    case 32:
      return 2;
  }
}

export function emitLoadGuestMemoryUnchecked(
  body: WasmFunctionBodyEncoder,
  emitAddress: WasmMemoryAddressProducer,
  width: OperandWidth,
  signed = false
): WasmEmittedValue {
  emitAddress();
  emitI32Load(body, guestImmediate(width), width, signed);
  return wasmI32(signed ? 32 : width);
}

export function emitStoreGuestMemoryUnchecked(
  body: WasmFunctionBodyEncoder,
  emitAddress: WasmMemoryAddressProducer,
  emitValue: WasmMemoryValueProducer,
  width: OperandWidth
): void {
  emitAddress();
  emitValue();
  emitI32Store(body, guestImmediate(width), width);
}

export function emitStoreGuestMemoryFromStackUnchecked(
  body: WasmFunctionBodyEncoder,
  width: OperandWidth
): void {
  emitI32Store(body, guestImmediate(width), width);
}

export function emitGuardGuestMemoryRange(
  body: WasmFunctionBodyEncoder,
  addressLocal: number,
  byteLength: number,
  emitFault: WasmMemoryFaultEmitter
): void {
  assert(byteLength > 0, `Wasm memory guard byte length must be positive, got ${byteLength}`);

  emitGuestMemoryByteLength(body);
  body.i32Const(byteLength).i32LtU();

  body.localGet(addressLocal);
  emitLastValidGuestAddress(body, byteLength);
  body.i32GtU();

  body.i32Or().ifBlock(wasmBranchHint.unlikely);
  emitFault();
  body.endBlock();
}

export function emitI32Load(
  body: WasmFunctionBodyEncoder,
  immediate: WasmMemoryImmediate,
  width: OperandWidth,
  signed = false
): void {
  switch (width) {
    case 8:
      if (signed) {
        body.i32Load8S(immediate);
      } else {
        body.i32Load8U(immediate);
      }
      return;
    case 16:
      if (signed) {
        body.i32Load16S(immediate);
      } else {
        body.i32Load16U(immediate);
      }
      return;
    case 32:
      body.i32Load(immediate);
      return;
  }
}

export function emitI32Store(
  body: WasmFunctionBodyEncoder,
  immediate: WasmMemoryImmediate,
  width: OperandWidth
): void {
  switch (width) {
    case 8:
      body.i32Store8(immediate);
      return;
    case 16:
      body.i32Store16(immediate);
      return;
    case 32:
      body.i32Store(immediate);
      return;
  }
}

function guestImmediate(width: OperandWidth): WasmMemoryImmediate {
  return {
    align: wasmMemoryAlignForWidth(width),
    memoryIndex: wasmMemoryIndex.guest,
    offset: 0
  };
}

function emitLastValidGuestAddress(
  body: WasmFunctionBodyEncoder,
  byteLength: number
): void {
  emitGuestMemoryByteLength(body);
  body.i32Const(byteLength).i32Sub();
}

function emitGuestMemoryByteLength(body: WasmFunctionBodyEncoder): void {
  body
    .memorySize(wasmMemoryIndex.guest)
    .i32Const(wasmPageShift)
    .i32Shl();
}
