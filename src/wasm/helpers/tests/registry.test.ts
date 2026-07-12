import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmValueType } from "#compiler/encoder/types.js";
import { HelperRegistry } from "#wasm/helpers/registry.js";

const helperType = {
  params: [],
  results: [wasmValueType.i32]
} as const;

test("define is idempotent for repeated keys", () => {
  const registry = new HelperRegistry(new WasmModuleEncoder(), helperType, (key: string) => key);
  const first = registry.define("same", () => helperBody(1));
  const second = registry.define("same", () => helperBody(2));

  strictEqual(first, 0);
  strictEqual(second, first);
  strictEqual(registry.functionIndex("same"), first);
  strictEqual(registry.helpers().length, 1);
});

test("requireFunctionIndex fails clearly for missing helpers", () => {
  const registry = new HelperRegistry(new WasmModuleEncoder(), helperType, (key: string) => key);

  throws(() => registry.requireFunctionIndex("missing", "missingHelper"), /missing Wasm helper missingHelper/);
});

test("helpers reports definition order", () => {
  const registry = new HelperRegistry(new WasmModuleEncoder(), helperType, (key: string) => key);

  registry.define("b", () => helperBody(2));
  registry.define("a", () => helperBody(1));

  strictEqual(registry.helpers()[0], "b");
  strictEqual(registry.helpers()[1], "a");
});

function helperBody(value: number): WasmFunctionBodyEncoder {
  return new WasmFunctionBodyEncoder().i32Const(value).end();
}
