import { assert } from "#common/assert.js";
import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { wasmValueType } from "#compiler/encoder/types.js";

// Cross-iteration interpreter locals: architectural decode state that survives
// prefix rescans, plus the opcode fetch byte. Operand and dispatch scratch
// locals are allocated at their emission sites.
export class InterpreterLocals {
  readonly eip: number;
  readonly byte: number;
  // Prefix bits (bit 0: operand size, bits 1-2: REP group), reset per instruction.
  readonly prefixFlags: number;
  // Segment override local: no override sentinel or a segmentRegisters index.
  readonly segment: number;
  // The instruction start; fault paths commit it while eip is rebased.
  readonly instructionStart: number;

  constructor(body: WasmFunctionBodyEncoder) {
    this.eip = body.addLocal(wasmValueType.i32);
    this.byte = body.addLocal(wasmValueType.i32);
    this.prefixFlags = body.addLocal(wasmValueType.i32);
    this.segment = body.addLocal(wasmValueType.i32);
    this.instructionStart = body.addLocal(wasmValueType.i32);
  }
}

export type HandlerScratch = Readonly<{
  nextEip: number;
  effectiveSegment: number;
  offset: number;
}>;

export function withHandlerScratch<Result>(
  scratch: WasmLocalScratchAllocator,
  callback: (locals: HandlerScratch) => Result
): Result {
  return scratch.withLocals([wasmValueType.i32, wasmValueType.i32, wasmValueType.i32], ([
    nextEip,
    effectiveSegment,
    offset
  ]) => {
    return callback({ nextEip, effectiveSegment, offset });
  });
}

export type ModRmScratch = Readonly<{
  mod: number;
  reg: number;
  rm: number;
}>;

export function withModRmScratch<Result>(
  scratch: WasmLocalScratchAllocator,
  callback: (locals: ModRmScratch) => Result
): Result {
  return scratch.withLocals([wasmValueType.i32, wasmValueType.i32, wasmValueType.i32], ([mod, reg, rm]) => {
    return callback({ mod, reg, rm });
  });
}

export type RmAddressScratch = Readonly<{
  base: number;
  offset: number;
  addressCursor: number;
}>;

export function withRmAddressScratch<Result>(
  scratch: WasmLocalScratchAllocator,
  callback: (locals: RmAddressScratch) => Result
): Result {
  return scratch.withLocals([wasmValueType.i32, wasmValueType.i32, wasmValueType.i32], ([
    base,
    offset,
    addressCursor
  ]) => {
    return callback({ base, offset, addressCursor });
  });
}

export function withValueOperandScratch<Result>(
  scratch: WasmLocalScratchAllocator,
  count: number,
  callback: (locals: readonly number[]) => Result
): Result {
  assert(Number.isInteger(count) && count >= 0, `i32 scratch local count out of range: ${count}`);
  return scratch.withLocals(Array.from({ length: count }, () => wasmValueType.i32), callback);
}
