import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { encodeWasmModule } from "#compiler/encoder/module.js";
import { wasmFunctionTypeCount } from "#compiler/encoder/tests/body-opcodes.js";
import { testModuleDescription } from "#compiler/encoder/tests/module-description.js";
import { wasmValueType } from "#compiler/encoder/types.js";

test("serializes every declared function type entry", () => {
  const type = {
    params: [] as const,
    results: [wasmValueType.i32] as const
  };
  const bytes = encodeWasmModule(testModuleDescription({
    functionTypes: [type, type]
  }));

  strictEqual(wasmFunctionTypeCount(bytes), 2);
  new WebAssembly.Module(bytes);
});

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

test("configured validation runs before module serialization", () => {
  throws(
    () => encodeWasmModule(testModuleDescription({
      functions: [{
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder().finish()
      }]
    })),
    /unknown Wasm function type index/
  );
});
