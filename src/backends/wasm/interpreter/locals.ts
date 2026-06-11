import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { wasmValueType } from "#wasm/encoder/types.js";

// The dispatch locals: everything decode fragments export and handlers
// consume as externals. One set serves the whole loop; each dispatch case
// writes only what its instruction uses.
export class InterpreterLocals {
  readonly eip: number;
  readonly byte: number;
  readonly mod: number;
  readonly reg: number;
  readonly rm: number;
  readonly address: number;
  readonly length: number;
  readonly imm: number;
  readonly target: number;
  readonly nextEip: number;

  constructor(body: WasmFunctionBodyEncoder) {
    this.eip = body.addLocal(wasmValueType.i32);
    this.byte = body.addLocal(wasmValueType.i32);
    this.mod = body.addLocal(wasmValueType.i32);
    this.reg = body.addLocal(wasmValueType.i32);
    this.rm = body.addLocal(wasmValueType.i32);
    this.address = body.addLocal(wasmValueType.i32);
    this.length = body.addLocal(wasmValueType.i32);
    this.imm = body.addLocal(wasmValueType.i32);
    this.target = body.addLocal(wasmValueType.i32);
    this.nextEip = body.addLocal(wasmValueType.i32);
  }
}
