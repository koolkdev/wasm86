import { strictEqual } from "node:assert";
import { test } from "node:test";

import { encodeWasmFunctionBody } from "#wasm/encoder/function-body.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import { encodeWasmModule } from "#wasm/encoder/module.js";
import { createTestModuleDescription } from "#wasm/encoder/tests/module-fixture.js";
import { wasmValueType } from "#wasm/encoder/types.js";

test("ordered module description uses declared numeric positions", async () => {
  const bytes = encodeWasmModule(
    createTestModuleDescription({
      functionTypes: [
        { params: [], results: [] },
        { params: [], results: [wasmValueType.i32] }
      ],
      functions: [
        {
          typeIndex: 1,
          body: encodeWasmFunctionBody(
            {
              parameterCount: 0,
              localTypes: []
            },
            (writer) => {
              writer.write(wasmInstruction.i32.const, 42);
            }
          )
        }
      ],
      functionExports: [{ name: "answer", functionIndex: 0 }]
    })
  );
  const instance = await WebAssembly.instantiate(bytes);
  const answer = instance.instance.exports.answer;

  if (typeof answer !== "function") {
    throw new Error("expected exported function 'answer'");
  }
  strictEqual(answer(), 42);
});
