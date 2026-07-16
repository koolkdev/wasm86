import { assert } from "#common/assert.js";
import type { OperandWidth } from "#core/types.js";
import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { WasmMemoryImmediate } from "#compiler/encoder/memory.js";
import { wasmGuestMemoryMinByteLength, wasmMemoryIndex } from "#wasm/abi.js";
import type { StorageAccess } from "#compiler/ir/effects.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  type DeclaredOperationInputs,
  type OperationDefinition,
  type OperationEmitTarget,
  type OperationResult
} from "./definition.js";

const memoryAccess: StorageAccess = { space: "memory" };
const memoryBoundsAccess: StorageAccess = { space: "memoryBounds" };
const booleanResult: OperationResult = { type: "i32", bounds: fitsUnsigned(1) };

type MemoryReadArgs = Readonly<{
  address: ValueId;
  byteOffset: number;
  width: OperandWidth;
  signed?: true;
}>;

export const memoryRead: OperationDefinition<
  "memory.read",
  MemoryReadArgs,
  OperationResult
> = {
  kind: "memory.read",

  create(op) {
    assert(
      Number.isInteger(op.byteOffset) && op.byteOffset >= 0 && op.byteOffset <= 0xffff_ffff,
      `memory.read byte offset must be an unsigned 32-bit integer, got ${op.byteOffset}`
    );
    return {
      kind: "memory.read",
      address: op.address,
      byteOffset: op.byteOffset,
      width: op.width,
      ...(op.signed === true ? { signed: true } : {}),
      inputs: [{ value: op.address, type: "i32" }],
      result: memoryReadResult(op.width, op.signed === true),
      effects: {
        reads: [memoryAccess],
        writes: []
      }
    };
  },

  emit(operation, { body }, inputs) {
    inputs.use(0);
    const immediate = guestImmediate(operation.width, operation.byteOffset);

    switch (operation.width) {
      case 8:
        operation.signed === true ? body.i32Load8S(immediate) : body.i32Load8U(immediate);
        return;
      case 16:
        operation.signed === true ? body.i32Load16S(immediate) : body.i32Load16U(immediate);
        return;
      case 32:
        body.i32Load(immediate);
        return;
    }
  }
};

type MemoryWriteArgs = Readonly<{
  address: ValueId;
  byteOffset: number;
  value: ValueId;
  width: OperandWidth;
}>;

export const memoryWrite: OperationDefinition<
  "memory.write",
  MemoryWriteArgs,
  undefined
> = {
  kind: "memory.write",

  create(op) {
    assert(
      Number.isInteger(op.byteOffset) && op.byteOffset >= 0 && op.byteOffset <= 0xffff_ffff,
      `memory.write byte offset must be an unsigned 32-bit integer, got ${op.byteOffset}`
    );
    return {
      kind: "memory.write",
      address: op.address,
      byteOffset: op.byteOffset,
      value: op.value,
      width: op.width,
      inputs: [
        { value: op.address, type: "i32" },
        { value: op.value, type: "i32" }
      ],
      result: undefined,
      effects: {
        reads: [],
        writes: [memoryAccess]
      }
    };
  },

  emit(operation, { body }, inputs) {
    inputs.use(0);
    inputs.use(1);
    const immediate = guestImmediate(operation.width, operation.byteOffset);

    switch (operation.width) {
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
};

type MemoryCheckArgs = Readonly<{
  address: ValueId;
  byteLength: ValueId;
}>;

export const memoryCheck: OperationDefinition<
  "memory.check",
  MemoryCheckArgs,
  OperationResult
> = {
  kind: "memory.check",

  create(op) {
    return {
      kind: "memory.check",
      address: op.address,
      byteLength: op.byteLength,
      inputs: [
        { value: op.address, type: "i32" },
        { value: op.byteLength, type: "i32" }
      ],
      result: booleanResult,
      effects: {
        reads: [memoryBoundsAccess],
        writes: []
      }
    };
  },

  emit(_operation, target, inputs) {
    emitMemoryCheck(target, inputs);
  }
};

type MemoryResolveArgs = Readonly<{
  address: ValueId;
  byteLength: ValueId;
}>;

export const memoryResolve: OperationDefinition<
  "memory.resolve",
  MemoryResolveArgs,
  OperationResult
> = {
  kind: "memory.resolve",

  create(op) {
    return {
      kind: "memory.resolve",
      address: op.address,
      byteLength: op.byteLength,
      inputs: [
        { value: op.address, type: "i32" },
        { value: op.byteLength, type: "i32" }
      ],
      result: booleanResult,
      effects: {
        reads: [memoryBoundsAccess],
        writes: []
      }
    };
  },

  emit(_operation, target, inputs) {
    emitMemoryCheck(target, inputs);
  }
};

const i32Result: OperationResult = { type: "i32" };

function memoryReadResult(width: OperandWidth, signed: boolean): OperationResult {
  if (width === 32) {
    return i32Result;
  }
  return { type: "i32", bounds: signed ? signExtended(width) : fitsUnsigned(width) };
}

const wasmPageShift = 16;

function emitMemoryCheck(
  target: OperationEmitTarget,
  inputs: DeclaredOperationInputs
): void {
  const { body } = target;
  const staticByteLength = inputs.constValue(1);

  if (staticByteLength !== undefined) {
    inputs.use(0);
    emitMemoryCheckFromStack(body, staticByteLength);
    return;
  }

  target.withTemporaryLocal("i32", (byteLengthLocal) => {
    inputs.use(1);
    body.localTee(byteLengthLocal).i32Const(0).i32Ne();

    body.localGet(byteLengthLocal);
    emitGuestByteLength(body);
    body.i32GtU();

    inputs.use(0);
    emitGuestByteLength(body);
    body.localGet(byteLengthLocal).i32Sub().i32GtU();

    body.i32Or().i32And();
  });
}

function emitMemoryCheckFromStack(
  body: WasmFunctionBodyEncoder,
  byteLength: number
): void {
  assert(byteLength > 0, `guest access byte length must be positive, got ${byteLength}`);
  assert(
    byteLength <= wasmGuestMemoryMinByteLength,
    "guest access exceeds the minimum imported memory"
  );

  // Unsigned address <= guestByteLength - byteLength is the complete static
  // range check; the imported minimum guarantees the subtraction cannot wrap.
  emitGuestByteLength(body);
  body.i32Const(byteLength).i32Sub().i32GtU();
}

function emitGuestByteLength(body: WasmFunctionBodyEncoder): void {
  body
    .memorySize(wasmMemoryIndex.guest)
    .i32Const(wasmPageShift)
    .i32Shl();
}

function guestImmediate(width: OperandWidth, byteOffset: number): WasmMemoryImmediate {
  return {
    align: guestAlign[width],
    offset: byteOffset,
    memoryIndex: wasmMemoryIndex.guest
  };
}

const guestAlign: Readonly<Record<OperandWidth, number>> = {
  8: 0,
  16: 1,
  32: 2
};
