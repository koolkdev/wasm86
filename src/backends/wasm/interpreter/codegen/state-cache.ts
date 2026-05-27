import { reg32, type Reg32 } from "#x86/types.js";
import { stateOffset } from "#wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { emitLoadStateU32, emitStoreStateU32 } from "#wasm/codegen/state.js";

export type InterpreterStateCache = Readonly<{
  eipLocal: number;
  aluFlagsLocal: number;
  instructionCountLocal: number;
  regs: Readonly<Record<Reg32, number>>;
}>;

export function createInterpreterStateCache(
  body: WasmFunctionBodyEncoder,
  eipLocal: number
): InterpreterStateCache {
  const regs = Object.fromEntries(
    reg32.map((reg) => [reg, body.addLocal(wasmValueType.i32)])
  ) as Record<Reg32, number>;

  return {
    eipLocal,
    aluFlagsLocal: body.addLocal(wasmValueType.i32),
    instructionCountLocal: body.addLocal(wasmValueType.i32),
    regs
  };
}

export function emitLoadInterpreterStateCache(body: WasmFunctionBodyEncoder, cache: InterpreterStateCache): void {
  for (const reg of reg32) {
    emitLoadStateU32(body, stateOffset[reg]);
    body.localSet(cache.regs[reg]);
  }

  emitLoadStateU32(body, stateOffset.eip);
  body.localSet(cache.eipLocal);

  emitLoadStateU32(body, stateOffset.aluFlags);
  body.localSet(cache.aluFlagsLocal);

  emitLoadStateU32(body, stateOffset.instructionCount);
  body.localSet(cache.instructionCountLocal);
}

export function emitFlushInterpreterStateCache(body: WasmFunctionBodyEncoder, cache: InterpreterStateCache): void {
  for (const reg of reg32) {
    emitStoreStateU32(body, stateOffset[reg], () => {
      body.localGet(cache.regs[reg]);
    });
  }

  emitStoreStateU32(body, stateOffset.eip, () => {
    body.localGet(cache.eipLocal);
  });
  emitStoreStateU32(body, stateOffset.aluFlags, () => {
    body.localGet(cache.aluFlagsLocal);
  });
  emitStoreStateU32(body, stateOffset.instructionCount, () => {
    body.localGet(cache.instructionCountLocal);
  });
}

export function emitCompleteInstruction(
  body: WasmFunctionBodyEncoder,
  cache: InterpreterStateCache,
  instructionLength: number
): void {
  emitCompleteInstructionWithTarget(body, cache, () => {
    body.localGet(cache.eipLocal).i32Const(instructionLength).i32Add();
  });
}

export function emitCompleteInstructionWithTarget(
  body: WasmFunctionBodyEncoder,
  cache: InterpreterStateCache,
  emitTarget: () => void
): void {
  emitTarget();
  body.localSet(cache.eipLocal);
  emitIncrementInstructionCount(body, cache);
}

function emitIncrementInstructionCount(body: WasmFunctionBodyEncoder, cache: InterpreterStateCache): void {
  body.localGet(cache.instructionCountLocal).i32Const(1).i32Add().localSet(cache.instructionCountLocal);
}
