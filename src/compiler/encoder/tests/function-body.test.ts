import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";

test("descriptive branch hints are encoded in function metadata", () => {
  const body = new WasmFunctionBodyEncoder()
    .i32Const(1)
    .ifBlock({ hint: "unlikely" })
    .endBlock()
    .block()
    .i32Const(1)
    .brIf(0, "likely")
    .endBlock()
    .finish();

  deepStrictEqual(
    body.branchHints,
    [
      { offset: 3, value: 0 },
      { offset: 10, value: 1 }
    ]
  );
});

test("a function body cannot be changed after finish", () => {
  const encoder = new WasmFunctionBodyEncoder();

  encoder.finish();

  throws(() => encoder.i32Const(1), /cannot write after.*finished/);
  throws(() => encoder.addLocal(0x7f), /cannot add local after.*finished/);
  throws(() => encoder.finish(), /cannot write after.*finished/);
});
