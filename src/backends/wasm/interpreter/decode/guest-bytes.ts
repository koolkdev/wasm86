import { wasmMemoryIndex } from "#backends/wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { emitWasmIrExitFromI32Stack, type WasmIrExitDestination } from "#backends/wasm/codegen/exit.js";

const wasmPageByteShift = 16;
const accessByteLength = {
  8: 1,
  16: 2,
  32: 4
} as const;

export function emitLoadGuestByte(
  body: WasmFunctionBodyEncoder,
  eipLocal: number,
  instructionOffset: number,
  addressLocal: number,
  byteLocal: number,
  exit?: WasmIrExitDestination
): void {
  body.localGet(eipLocal);

  if (instructionOffset !== 0) {
    body.i32Const(instructionOffset).i32Add();
  }

  body.localSet(addressLocal);
  emitFaultIfGuestAccessOutOfBounds(body, addressLocal, 8, exit);
  body.localGet(addressLocal).i32Load8U({ align: 0, offset: 0, memoryIndex: wasmMemoryIndex.guest }).localSet(byteLocal);
}

export function emitLoadGuestByteAtDynamicOffset(
  body: WasmFunctionBodyEncoder,
  eipLocal: number,
  instructionOffsetLocal: number,
  addressLocal: number,
  byteLocal: number,
  exit?: WasmIrExitDestination
): void {
  body.localGet(eipLocal).localGet(instructionOffsetLocal).i32Add().localSet(addressLocal);
  emitFaultIfGuestAccessOutOfBounds(body, addressLocal, 8, exit);
  body.localGet(addressLocal).i32Load8U({ align: 0, offset: 0, memoryIndex: wasmMemoryIndex.guest }).localSet(byteLocal);
}

export function emitLoadGuestUnsigned(
  body: WasmFunctionBodyEncoder,
  eipLocal: number,
  instructionOffset: number,
  width: 8 | 16 | 32,
  addressLocal: number,
  valueLocal: number,
  exit?: WasmIrExitDestination
): void {
  body.localGet(eipLocal);

  if (instructionOffset !== 0) {
    body.i32Const(instructionOffset).i32Add();
  }

  body.localSet(addressLocal);
  emitFaultIfGuestAccessOutOfBounds(body, addressLocal, width, exit);
  emitGuestDecodeLoad(body, addressLocal, width, valueLocal);
}

export function emitLoadGuestUnsignedAtDynamicOffset(
  body: WasmFunctionBodyEncoder,
  eipLocal: number,
  instructionOffsetLocal: number,
  width: 8 | 16 | 32,
  addressLocal: number,
  valueLocal: number,
  exit?: WasmIrExitDestination
): void {
  body.localGet(eipLocal).localGet(instructionOffsetLocal).i32Add().localSet(addressLocal);
  emitFaultIfGuestAccessOutOfBounds(body, addressLocal, width, exit);
  emitGuestDecodeLoad(body, addressLocal, width, valueLocal);
}

function emitGuestDecodeLoad(
  body: WasmFunctionBodyEncoder,
  addressLocal: number,
  width: 8 | 16 | 32,
  valueLocal: number
): void {
  body.localGet(addressLocal);

  switch (width) {
    case 8:
      body.i32Load8U({ align: 0, offset: 0, memoryIndex: wasmMemoryIndex.guest }).localSet(valueLocal);
      return;
    case 16:
      body.i32Load16U({ align: 0, offset: 0, memoryIndex: wasmMemoryIndex.guest }).localSet(valueLocal);
      return;
    case 32:
      body.i32Load({ align: 0, offset: 0, memoryIndex: wasmMemoryIndex.guest }).localSet(valueLocal);
      return;
  }
}

function emitFaultIfGuestAccessOutOfBounds(
  body: WasmFunctionBodyEncoder,
  addressLocal: number,
  width: 8 | 16 | 32,
  exit?: WasmIrExitDestination
): void {
  body
    .memorySize(wasmMemoryIndex.guest)
    .i32Const(wasmPageByteShift)
    .i32Shl()
    .i32Const(accessByteLength[width])
    .i32Sub()
    .localGet(addressLocal)
    .i32LtU()
    .ifBlock();
  emitDecodeFault(body, addressLocal, exit, 1);
  body.endBlock();
}

function emitDecodeFault(
  body: WasmFunctionBodyEncoder,
  addressLocal: number,
  exit: WasmIrExitDestination | undefined,
  extraDepth: number
): void {
  if (exit === undefined) {
    body.localGet(addressLocal);
    throw new Error("interpreter guest-byte fault requires an exit target");
  }

  body.localGet(addressLocal);
  emitWasmIrExitFromI32Stack(body, {
    destination: exit,
    reason: ExitReason.DECODE_FAULT,
    extraDepth
  });
}
