import { wasmMemoryIndex } from "#wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";

export const stateU32Align = 2;

export function emitLoadStateU8(body: WasmFunctionBodyEncoder, offset: number): void {
  body.i32Const(0).i32Load8U({
    align: 0,
    memoryIndex: wasmMemoryIndex.state,
    offset
  });
}

export function emitLoadStateS8(body: WasmFunctionBodyEncoder, offset: number): void {
  body.i32Const(0).i32Load8S({
    align: 0,
    memoryIndex: wasmMemoryIndex.state,
    offset
  });
}

export function emitLoadStateU16(body: WasmFunctionBodyEncoder, offset: number): void {
  body.i32Const(0).i32Load16U({
    align: offset % 2 === 0 ? 1 : 0,
    memoryIndex: wasmMemoryIndex.state,
    offset
  });
}

export function emitLoadStateS16(body: WasmFunctionBodyEncoder, offset: number): void {
  body.i32Const(0).i32Load16S({
    align: offset % 2 === 0 ? 1 : 0,
    memoryIndex: wasmMemoryIndex.state,
    offset
  });
}

export function emitLoadStateU32(body: WasmFunctionBodyEncoder, offset: number): void {
  body.i32Const(0).i32Load({
    align: stateU32Align,
    memoryIndex: wasmMemoryIndex.state,
    offset
  });
}

export function emitStoreStateStackU32(body: WasmFunctionBodyEncoder, offset: number): void {
  body.i32Store({
    align: stateU32Align,
    memoryIndex: wasmMemoryIndex.state,
    offset
  });
}

export function emitStoreStateU8(body: WasmFunctionBodyEncoder, offset: number, emitValue: () => void): void {
  body.i32Const(0);
  emitValue();
  body.i32Store8({
    align: 0,
    memoryIndex: wasmMemoryIndex.state,
    offset
  });
}

export function emitStoreStateU16(body: WasmFunctionBodyEncoder, offset: number, emitValue: () => void): void {
  body.i32Const(0);
  emitValue();
  body.i32Store16({
    align: offset % 2 === 0 ? 1 : 0,
    memoryIndex: wasmMemoryIndex.state,
    offset
  });
}

export function emitStoreStateU32(body: WasmFunctionBodyEncoder, offset: number, emitValue: () => void): void {
  body.i32Const(0);
  emitValue();
  emitStoreStateStackU32(body, offset);
}
