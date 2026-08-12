import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { functionType } from "#compiler/function/type.js";
import { Float, Integer } from "#compiler/function/values.js";
import {
  toWasmFunctionType,
  toWasmValueType,
  wasmIntegerWidth
} from "#compiler/wasm/type-mapping.js";

test("logical value types project to their Wasm carriers", () => {
  strictEqual(toWasmValueType(Integer[1]), "i32");
  strictEqual(toWasmValueType(Integer[8]), "i32");
  strictEqual(toWasmValueType(Integer[16]), "i32");
  strictEqual(toWasmValueType(Integer[32]), "i32");
  strictEqual(toWasmValueType(Integer[64]), "i64");
  strictEqual(toWasmValueType(Float[32]), "f32");
  strictEqual(toWasmValueType(Float[64]), "f64");
  strictEqual(wasmIntegerWidth(8), 32);
  strictEqual(wasmIntegerWidth(64), 64);
  deepStrictEqual(toWasmFunctionType(functionType([Integer[8], Float[64]], [Integer[64]])), {
    parameters: ["i32", "f64"],
    results: ["i64"]
  });
});
