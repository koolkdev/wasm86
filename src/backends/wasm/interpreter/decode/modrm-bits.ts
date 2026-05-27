import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";

const modRmModMask = 0b1100_0000;
const modRmRegShift = 3;
const modRmRegMask = 0b111;

export function emitModRmRegIndex(body: WasmFunctionBodyEncoder, modRmLocal: number): void {
  body.localGet(modRmLocal).i32Const(modRmRegShift).i32ShrU().i32Const(modRmRegMask).i32And();
}

export function emitModRmIsRegister(body: WasmFunctionBodyEncoder, modRmLocal: number): void {
  body
    .localGet(modRmLocal)
    .i32Const(modRmModMask)
    .i32And()
    .i32Const(modRmModMask)
    .i32Xor()
    .i32Eqz();
}

export function emitModRmIsMemory(body: WasmFunctionBodyEncoder, modRmLocal: number): void {
  emitModRmIsRegister(body, modRmLocal);
  body.i32Eqz();
}

export function emitIfModRmRegister(
  body: WasmFunctionBodyEncoder,
  modRmLocal: number,
  emitThen: () => void
): void {
  emitModRmIsRegister(body, modRmLocal);
  body.ifBlock();
  emitThen();
  body.endBlock();
}

export function emitIfModRmMemory(
  body: WasmFunctionBodyEncoder,
  modRmLocal: number,
  emitThen: () => void
): void {
  emitModRmIsMemory(body, modRmLocal);
  body.ifBlock();
  emitThen();
  body.endBlock();
}
