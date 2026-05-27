import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmValueType } from "#wasm/encoder/types.js";

test("wasm_local_scratch_reuses_released_i32_local", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const scratch = new WasmLocalScratchAllocator(body);
  const first = scratch.allocLocal(wasmValueType.i32);

  scratch.freeLocal(first);

  const second = scratch.allocLocal(wasmValueType.i32);

  strictEqual(second, first);
});

test("wasm_local_scratch_keeps_value_type_pools_separate", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const scratch = new WasmLocalScratchAllocator(body);
  const i32Local = scratch.allocLocal(wasmValueType.i32);
  const i64Local = scratch.allocLocal(wasmValueType.i64);

  scratch.freeLocal(i32Local);
  scratch.freeLocal(i64Local);

  const reusedI64 = scratch.allocLocal(wasmValueType.i64);
  const reusedI32 = scratch.allocLocal(wasmValueType.i32);

  strictEqual(reusedI64, i64Local);
  strictEqual(reusedI32, i32Local);
});

test("wasm_local_scratch_rejects_invalid_local_release", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const scratch = new WasmLocalScratchAllocator(body);
  const permanent = body.addLocal(wasmValueType.i32);
  const temporary = scratch.allocLocal(wasmValueType.i32);

  throws(() => scratch.freeLocal(permanent), /non-scratch local/);

  scratch.freeLocal(temporary);

  throws(() => scratch.freeLocal(temporary), /already free/);
});

test("wasm_local_scratch_asserts_clear_state", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const scratch = new WasmLocalScratchAllocator(body);
  const temporary = scratch.allocLocal(wasmValueType.i32);

  throws(() => scratch.assertClear(), /still in use/);

  scratch.freeLocal(temporary);
  scratch.assertClear();
});
