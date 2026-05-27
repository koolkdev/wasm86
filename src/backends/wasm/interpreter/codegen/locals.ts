import { wasmValueType } from "#wasm/encoder/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";

export class InterpreterLocals {
  readonly eip: number;
  readonly byte: number;
  readonly address: number;
  readonly opcode: number;
  readonly opcodeOffset: number;
  readonly exit: number;

  constructor(body: WasmFunctionBodyEncoder) {
    this.eip = body.addLocal(wasmValueType.i32);
    this.byte = body.addLocal(wasmValueType.i32);
    this.address = body.addLocal(wasmValueType.i32);
    this.opcode = body.addLocal(wasmValueType.i32);
    this.opcodeOffset = body.addLocal(wasmValueType.i32);
    this.exit = body.addLocal(wasmValueType.i64);
  }
}
