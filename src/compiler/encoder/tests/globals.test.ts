import { strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmValueType } from "#compiler/encoder/types.js";

test("a mutable i32 global initializes and round-trips through set/get", async () => {
  const module = new WasmModuleEncoder();
  const globalIndex = module.addGlobal({ type: wasmValueType.i32, mutable: true, initialValue: 7 });
  const getType = module.addFunctionType({ params: [], results: [wasmValueType.i32] });
  const setType = module.addFunctionType({ params: [wasmValueType.i32], results: [] });

  module.exportFunction(
    "get",
    module.addFunction(getType, new WasmFunctionBodyEncoder().globalGet(globalIndex).end())
  );
  module.exportFunction(
    "set",
    module.addFunction(setType, new WasmFunctionBodyEncoder(1).localGet(0).globalSet(globalIndex).end())
  );

  const instance = await WebAssembly.instantiate(await WebAssembly.compile(module.encode()));
  const get = exportedFunction(instance, "get");
  const set = exportedFunction(instance, "set");

  strictEqual(get(), 7);
  set(42);
  strictEqual(get(), 42);
});

test("an i64 global keeps its full-width initial value", async () => {
  const expected = 0x0006_0000_1234_5678n;
  const module = new WasmModuleEncoder();
  const globalIndex = module.addGlobal({ type: wasmValueType.i64, mutable: false, initialValue: expected });
  const getType = module.addFunctionType({ params: [], results: [wasmValueType.i64] });

  module.exportFunction(
    "get",
    module.addFunction(getType, new WasmFunctionBodyEncoder().globalGet(globalIndex).end())
  );

  const instance = await WebAssembly.instantiate(await WebAssembly.compile(module.encode()));

  strictEqual(exportedFunction(instance, "get")(), expected);
});

function exportedFunction(instance: WebAssembly.Instance, name: string): (...args: number[]) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (...args: number[]) => unknown;
}
