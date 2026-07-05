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
  readonly base: number;
  readonly offset: number;
  // Cursor after the decoded rm address bytes, from the rebased eip.
  readonly addressCursor: number;
  readonly imm: number;
  readonly target: number;
  readonly nextEip: number;
  // Prefix bits (bit 0: operand size), reset per instruction.
  readonly prefixFlags: number;
  // Segment override local: no override sentinel or a segmentRegisters index.
  readonly segment: number;
  // The resolved segmentRegisters index for the current memory operand.
  readonly effectiveSegment: number;
  // The instruction start; fault paths commit it while eip is rebased.
  readonly instructionStart: number;

  constructor(body: WasmFunctionBodyEncoder) {
    this.eip = body.addLocal(wasmValueType.i32);
    this.byte = body.addLocal(wasmValueType.i32);
    this.mod = body.addLocal(wasmValueType.i32);
    this.reg = body.addLocal(wasmValueType.i32);
    this.rm = body.addLocal(wasmValueType.i32);
    this.base = body.addLocal(wasmValueType.i32);
    this.offset = body.addLocal(wasmValueType.i32);
    this.addressCursor = body.addLocal(wasmValueType.i32);
    this.imm = body.addLocal(wasmValueType.i32);
    this.target = body.addLocal(wasmValueType.i32);
    this.nextEip = body.addLocal(wasmValueType.i32);
    this.prefixFlags = body.addLocal(wasmValueType.i32);
    this.segment = body.addLocal(wasmValueType.i32);
    this.effectiveSegment = body.addLocal(wasmValueType.i32);
    this.instructionStart = body.addLocal(wasmValueType.i32);
  }
}
