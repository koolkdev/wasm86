import { wasmMemoryIndex } from "#backends/wasm/abi.js";
import { wasmBranchHint, type WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { ExitReason } from "#backends/wasm/exit.js";
import type { OperandWidth } from "#x86/isa/types.js";
import { emitWasmIrExitFromI32Stack, type WasmIrExitTarget } from "./exit.js";

export type WasmIrMemoryAccess = "read" | "write";
export type WasmIrMemoryAddressEmitter = () => void;
export type WasmIrMemoryValueEmitter = () => void;

const memoryWidthByteLength = {
  8: 1,
  16: 2,
  32: 4
} as const satisfies Readonly<Record<OperandWidth, number>>;

const memoryWidthAlign = {
  8: 0,
  16: 1,
  32: 2
} as const satisfies Readonly<Record<OperandWidth, number>>;

const wasmPageShift = 16;

export type WasmIrMemoryContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  exit: WasmIrExitTarget;
}>;

export function emitWasmIrLoadGuestU32(
  context: WasmIrMemoryContext,
  addressLocal: number,
  faultExtraDepth = 1
): void {
  emitWasmIrLoadGuest(context, addressLocal, 32, faultExtraDepth);
}

export function emitWasmIrLoadGuestU32FromStack(
  context: WasmIrMemoryContext,
  addressLocal: number,
  faultExtraDepth = 1
): void {
  emitWasmIrLoadGuestFromStack(context, addressLocal, 32, faultExtraDepth);
}

export function emitWasmIrStoreGuestU32(
  context: WasmIrMemoryContext,
  addressLocal: number,
  valueLocal: number,
  faultExtraDepth = 1
): void {
  emitWasmIrStoreGuest(context, addressLocal, valueLocal, 32, faultExtraDepth);
}

export function emitWasmIrLoadGuest(
  context: WasmIrMemoryContext,
  addressLocal: number,
  width: OperandWidth,
  faultExtraDepth = 1,
  signed = false
): void {
  emitFaultIfOutOfBounds(context, addressLocal, width, "read", faultExtraDepth);
  emitWasmIrLoadGuestUnchecked(context.body, () => context.body.localGet(addressLocal), width, signed);
}

export function emitWasmIrLoadGuestFromStack(
  context: WasmIrMemoryContext,
  addressLocal: number,
  width: OperandWidth,
  faultExtraDepth = 1,
  signed = false
): void {
  emitFaultIfStackOutOfBounds(context, addressLocal, width, "read", faultExtraDepth);
  emitWasmIrLoadGuestUnchecked(context.body, () => context.body.localGet(addressLocal), width, signed);
}

export function emitWasmIrStoreGuest(
  context: WasmIrMemoryContext,
  addressLocal: number,
  valueLocal: number,
  width: OperandWidth,
  faultExtraDepth = 1
): void {
  emitFaultIfOutOfBounds(context, addressLocal, width, "write", faultExtraDepth);
  emitWasmIrStoreGuestUnchecked(
    context.body,
    () => context.body.localGet(addressLocal),
    () => context.body.localGet(valueLocal),
    width
  );
}

export function emitWasmIrGuardGuestRange(
  context: WasmIrMemoryContext,
  addressLocal: number,
  byteLength: number,
  access: WasmIrMemoryAccess,
  faultExtraDepth = 1
): void {
  emitFaultIfRangeOutOfBounds(context, addressLocal, byteLength, access, faultExtraDepth);
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

function emitFaultIfOutOfBounds(
  context: WasmIrMemoryContext,
  addressLocal: number,
  width: OperandWidth,
  access: WasmIrMemoryAccess,
  faultExtraDepth: number
): void {
  emitFaultIfRangeOutOfBounds(
    context,
    addressLocal,
    memoryWidthByteLength[width],
    access,
    faultExtraDepth
  );
}

function emitFaultIfStackOutOfBounds(
  context: WasmIrMemoryContext,
  addressLocal: number,
  width: OperandWidth,
  access: WasmIrMemoryAccess,
  faultExtraDepth: number
): void {
  context.body.localSet(addressLocal);
  emitFaultIfRangeOutOfBounds(
    context,
    addressLocal,
    memoryWidthByteLength[width],
    access,
    faultExtraDepth
  );
}

function emitFaultIfRangeOutOfBounds(
  context: WasmIrMemoryContext,
  addressLocal: number,
  byteLength: number,
  access: WasmIrMemoryAccess,
  faultExtraDepth: number
): void {
  validateGuardByteLength(byteLength);

  emitGuestMemoryByteLength(context.body);
  context.body.i32Const(byteLength).i32LtU().ifBlock(wasmBranchHint.unlikely);
  context.body.localGet(addressLocal);
  emitWasmIrMemoryFaultExitFromI32Stack(context, access, byteLength, faultExtraDepth);
  context.body.endBlock();

  context.body.localGet(addressLocal);
  emitLastValidGuestAddress(context.body, byteLength);
  context.body.i32GtU().ifBlock(wasmBranchHint.unlikely);
  context.body.localGet(addressLocal);
  emitWasmIrMemoryFaultExitFromI32Stack(context, access, byteLength, faultExtraDepth);
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

function emitWasmIrMemoryFaultExitFromI32Stack(
  context: WasmIrMemoryContext,
  access: WasmIrMemoryAccess,
  byteLength: number,
  extraDepth: number
): void {
  emitWasmIrExitFromI32Stack(
    context.body,
    context.exit,
    memoryFaultExitReason(access),
    extraDepth,
    byteLength
  );
}

function memoryFaultExitReason(access: WasmIrMemoryAccess): ExitReason {
  switch (access) {
    case "read":
      return ExitReason.MEMORY_READ_FAULT;
    case "write":
      return ExitReason.MEMORY_WRITE_FAULT;
  }
}
