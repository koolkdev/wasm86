import { strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { encodeWasmModule } from "#compiler/encoder/module.js";
import { testModuleDescription } from "#compiler/encoder/tests/module-description.js";
import { wasmValueType } from "#compiler/encoder/types.js";

test("ordered module description uses declared numeric positions", async () => {
  const bytes = encodeWasmModule(testModuleDescription({
    functionTypes: [
      { params: [], results: [] },
      { params: [], results: [wasmValueType.i32] }
    ],
    functions: [{
      typeIndex: 1,
      body: new WasmFunctionBodyEncoder().i32Const(42).finish()
    }],
    functionExports: [{ name: "answer", functionIndex: 0 }]
  }));
  const instance = await WebAssembly.instantiate(bytes);
  const answer = instance.instance.exports.answer;

  if (typeof answer !== "function") {
    throw new Error("expected exported function 'answer'");
  }
  strictEqual(answer(), 42);
});
