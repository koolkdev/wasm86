import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ValueScope } from "#compiler/function/values/scope.js";
import { Integer } from "#compiler/function/values/type.js";
import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import { ValueLowerer } from "../../values.js";

test("narrow parameters use zero-extended i32 internal ABI representations", () => {
  const values = new ValueScope();
  const byte = values.parameter(2, Integer[8]);

  values.resolve(byte);

  const wasm = new WasmValuesBuilder();
  const lowerer = new ValueLowerer(values, wasm);
  const base = lowerer.lower(byte);
  const unsigned = lowerer.normalize(byte, "unsigned");

  deepStrictEqual(wasm.node(base), {
    kind: "parameter",
    inputs: [],
    index: 2,
    type: "i32"
  });
  deepStrictEqual(wasm.requiredBits(base), {
    unsigned: 8,
    signed: 9
  });
  strictEqual(unsigned, base);
  strictEqual(wasm.finish().graph.length, 1);
});
