import type { ScalarCompareOp } from "#ir/expr/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";

export function compareUsesSignedOrder(op: ScalarCompareOp): boolean {
  switch (op) {
    case "lt_s":
    case "le_s":
    case "gt_s":
    case "ge_s":
      return true;
    case "eq":
    case "ne":
    case "lt_u":
    case "le_u":
    case "gt_u":
    case "ge_u":
      return false;
  }
}

export function emitI32CompareOp(body: WasmFunctionBodyEncoder, op: ScalarCompareOp): void {
  switch (op) {
    case "eq":
      body.i32Eq();
      return;
    case "ne":
      body.i32Ne();
      return;
    case "lt_u":
      body.i32LtU();
      return;
    case "le_u":
      body.i32LeU();
      return;
    case "gt_u":
      body.i32GtU();
      return;
    case "ge_u":
      body.i32GeU();
      return;
    case "lt_s":
      body.i32LtS();
      return;
    case "le_s":
      body.i32LeS();
      return;
    case "gt_s":
      body.i32GtS();
      return;
    case "ge_s":
      body.i32GeS();
      return;
  }
}
