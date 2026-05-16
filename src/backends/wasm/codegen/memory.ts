import { wasmMemoryIndex } from "#backends/wasm/abi.js";
import { wasmBranchHint, type WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { OperandWidth } from "#x86/isa/types.js";

export type WasmIrMemoryAccess = "read" | "write";
export type WasmIrMemoryAddressEmitter = () => void;
export type WasmIrMemoryValueEmitter = () => void;

const memoryWidthAlign = {
  8: 0,
  16: 1,
  32: 2
} as const satisfies Readonly<Record<OperandWidth, number>>;

const wasmPageShift = 16;

export type WasmIrMemoryContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  emitFaultExit(fault: WasmIrMemoryFault): void;
}>;

export type WasmIrMemoryGuardOptions = Readonly<{
  faultExtraDepth?: number;
}>;

export type WasmIrMemoryFault = Readonly<{
  byteLength: number;
  extraDepth: number;
}>;

export function emitWasmIrGuardGuestRange(
  context: WasmIrMemoryContext,
  addressLocal: number,
  byteLength: number,
  options: WasmIrMemoryGuardOptions = {}
): void {
  emitFaultIfRangeOutOfBounds(context, addressLocal, byteLength, options);
}

export function emitWasmIrLoadGuestUnchecked(
  body: WasmFunctionBodyEncoder,
  emitAddress: WasmIrMemoryAddressEmitter,
  width: OperandWidth,
  signed = false
): void {
  emitGuestLoad(body, emitAddress, width, signed);
}

export function emitWasmIrStoreGuestUnchecked(
  body: WasmFunctionBodyEncoder,
  emitAddress: WasmIrMemoryAddressEmitter,
  emitValue: WasmIrMemoryValueEmitter,
  width: OperandWidth
): void {
  emitGuestStore(body, emitAddress, emitValue, width);
}

function emitFaultIfRangeOutOfBounds(
  context: WasmIrMemoryContext,
  addressLocal: number,
  byteLength: number,
  options: WasmIrMemoryGuardOptions
): void {
  validateGuardByteLength(byteLength);

  const { faultExtraDepth = 1 } = options;

  emitGuestMemoryByteLength(context.body);
  context.body.i32Const(byteLength).i32LtU().ifBlock(wasmBranchHint.unlikely);
  context.body.localGet(addressLocal);
  emitMemoryFaultExit(context, byteLength, faultExtraDepth);
  context.body.endBlock();

  context.body.localGet(addressLocal);
  emitLastValidGuestAddress(context.body, byteLength);
  context.body.i32GtU().ifBlock(wasmBranchHint.unlikely);
  context.body.localGet(addressLocal);
  emitMemoryFaultExit(context, byteLength, faultExtraDepth);
  context.body.endBlock();
}

function validateGuardByteLength(byteLength: number): void {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error(`Wasm memory guard byte length must be a positive integer, got ${byteLength}`);
  }
}

function emitLastValidGuestAddress(body: WasmFunctionBodyEncoder, byteLength: number): void {
  emitGuestMemoryByteLength(body);
  body.i32Const(byteLength).i32Sub();
}

function emitGuestMemoryByteLength(body: WasmFunctionBodyEncoder): void {
  body
    .memorySize(wasmMemoryIndex.guest)
    .i32Const(wasmPageShift)
    .i32Shl();
}

function emitGuestLoad(
  body: WasmFunctionBodyEncoder,
  emitAddress: WasmIrMemoryAddressEmitter,
  width: OperandWidth,
  signed: boolean
): void {
  const immediate = {
    align: memoryWidthAlign[width],
    memoryIndex: wasmMemoryIndex.guest,
    offset: 0
  };

  emitAddress();

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

function emitGuestStore(
  body: WasmFunctionBodyEncoder,
  emitAddress: WasmIrMemoryAddressEmitter,
  emitValue: WasmIrMemoryValueEmitter,
  width: OperandWidth
): void {
  const immediate = {
    align: memoryWidthAlign[width],
    memoryIndex: wasmMemoryIndex.guest,
    offset: 0
  };

  emitAddress();
  emitValue();

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

function emitMemoryFaultExit(
  context: WasmIrMemoryContext,
  byteLength: number,
  extraDepth: number
): void {
  context.emitFaultExit({
    byteLength,
    extraDepth
  });
}
