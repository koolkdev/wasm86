import type { ScalarBinaryOp } from "#ir/expr/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";

export function emitI32BinaryOp(body: WasmFunctionBodyEncoder, op: ScalarBinaryOp): void {
  switch (op) {
    case "add":
      body.i32Add();
      return;
    case "sub":
      body.i32Sub();
      return;
    case "and":
      body.i32And();
      return;
    case "or":
      body.i32Or();
      return;
    case "xor":
      body.i32Xor();
      return;
    case "shl":
      body.i32Shl();
      return;
    case "shr_u":
      body.i32ShrU();
      return;
  }
}
