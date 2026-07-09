import { assert } from "#common/assert.js";
import type { ValueId } from "#ir/values.js";
import { wasmGuestMemoryMinByteLength, wasmMemoryIndex } from "#wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmMemoryImmediate } from "#wasm/encoder/memory.js";
import type { OperandWidth } from "#x86/types.js";
import type { OperandUses } from "./ops.js";

// Bounds checks and guest memory access. Guest addresses are arbitrary x86
// pointers, so accesses carry no static offset and only natural alignment
// hints.

const wasmPageShift = 16;

export function emitMemoryCheck(
  body: WasmFunctionBodyEncoder,
  operands: OperandUses,
  address: ValueId,
  byteLength: ValueId
): void {
  const staticByteLength = operands.constValue(byteLength);

  if (staticByteLength !== undefined) {
    operands.emitUse(address);
    emitMemoryCheckFromStack(body, staticByteLength);
    return;
  }

  emitDynamicMemoryCheck(body, operands, address, byteLength);
}

// Guest addresses are unsigned, so an access faults iff its start address
// exceeds the last in-bounds one, guestByteLength - byteLength. Instantiation
// enforces the guest import's declared minimum, so that subtraction cannot
// underflow for the 1/2/4-byte static accesses emitted by the current IR.
export function emitMemoryCheckFromStack(body: WasmFunctionBodyEncoder, byteLength: number): void {
  assert(byteLength > 0, `guest access byte length must be positive, got ${byteLength}`);
  assert(byteLength <= wasmGuestMemoryMinByteLength, "guest access exceeds the minimum imported memory");

  emitGuestByteLength(body);
  body.i32Const(byteLength).i32Sub().i32GtU();
}

export function emitGuestByteLength(body: WasmFunctionBodyEncoder): void {
  body
    .memorySize(wasmMemoryIndex.guest)
    .i32Const(wasmPageShift)
    .i32Shl();
}

export function emitGuestLoad(body: WasmFunctionBodyEncoder, width: OperandWidth, signed: boolean): void {
  const immediate = guestImmediate(width);

  switch (width) {
    case 8:
      signed ? body.i32Load8S(immediate) : body.i32Load8U(immediate);
      return;
    case 16:
      signed ? body.i32Load16S(immediate) : body.i32Load16U(immediate);
      return;
    case 32:
      // Sign extension from the full width is the identity.
      body.i32Load(immediate);
      return;
  }
}

export function emitGuestStore(body: WasmFunctionBodyEncoder, width: OperandWidth): void {
  const immediate = guestImmediate(width);

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

function emitDynamicMemoryCheck(
  body: WasmFunctionBodyEncoder,
  operands: OperandUses,
  addressId: ValueId,
  byteLengthId: ValueId
): void {
  const address = operands.borrowUse(addressId);
  const byteLength = operands.borrowUse(byteLengthId);

  byteLength.push();
  body.i32Const(0).i32Ne();

  byteLength.push();
  emitGuestByteLength(body);
  body.i32GtU();

  address.push();
  emitGuestByteLength(body);
  byteLength.push();
  body.i32Sub().i32GtU();

  body.i32Or().i32And();
  address.release();
  byteLength.release();
}

function guestImmediate(width: OperandWidth): WasmMemoryImmediate {
  return {
    align: guestAlign[width],
    offset: 0,
    memoryIndex: wasmMemoryIndex.guest
  };
}

const guestAlign = {
  8: 0,
  16: 1,
  32: 2
} as const satisfies Readonly<Record<OperandWidth, number>>;
