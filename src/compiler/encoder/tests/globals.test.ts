import { strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-fixture.js";
import { wasmValueType } from "#compiler/encoder/types.js";

test("a mutable i32 global initializes and round-trips through set/get", async () => {
  const bytes = encodeTestModule({
    functionTypes: [
      { params: [], results: [wasmValueType.i32] },
      { params: [wasmValueType.i32], results: [] }
    ],
    functions: [
      {
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder().globalGet(0).finish()
      },
      {
        typeIndex: 1,
        body: new WasmFunctionBodyEncoder(1).localGet(0).globalSet(0).finish()
      }
    ],
    globals: [{ type: wasmValueType.i32, mutable: true, initialValue: 7 }],
    functionExports: [
      { name: "get", functionIndex: 0 },
      { name: "set", functionIndex: 1 }
    ]
  });
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes));
  const get = exportedFunction(instance, "get");
  const set = exportedFunction(instance, "set");

  strictEqual(get(), 7);
  set(42);
  strictEqual(get(), 42);
});

test("an i64 global keeps its full-width initial value", async () => {
  const expected = 0x0006_0000_1234_5678n;
  const bytes = encodeTestModule({
    functionTypes: [{ params: [], results: [wasmValueType.i64] }],
    functions: [{
      typeIndex: 0,
      body: new WasmFunctionBodyEncoder().globalGet(0).finish()
    }],
    globals: [{ type: wasmValueType.i64, mutable: false, initialValue: expected }],
    functionExports: [{ name: "get", functionIndex: 0 }]
  });
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes));

  strictEqual(exportedFunction(instance, "get")(), expected);
});

function exportedFunction(instance: WebAssembly.Instance, name: string): (...args: number[]) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (...args: number[]) => unknown;
}
