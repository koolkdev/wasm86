import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { wasmValueType } from "#compiler/encoder/types.js";

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

test("br_table encodes its label vector and default depth", () => {
  const body = new WasmFunctionBodyEncoder(1)
    .block()
    .block()
    .block()
    .localGet(0)
    .brTable([1, 0], 2)
    .endBlock()
    .i32Const(20)
    .returnFromFunction()
    .endBlock()
    .i32Const(10)
    .returnFromFunction()
    .endBlock()
    .i32Const(30)
    .finish();

  deepStrictEqual([...body.bytes], [
    0x00,
    0x02, 0x40,
    0x02, 0x40,
    0x02, 0x40,
    0x20, 0x00,
    0x0e, 0x02, 0x01, 0x00, 0x02,
    0x0b,
    0x41, 0x14,
    0x0f,
    0x0b,
    0x41, 0x0a,
    0x0f,
    0x0b,
    0x41, 0x1e,
    0x0b
  ]);
});

test("narrow memory and sign-extension instructions use their Wasm encodings", () => {
  const body = new WasmFunctionBodyEncoder(2);
  const valueLocal = body.addLocal(wasmValueType.i32);

  body
    .localGet(0)
    .i32Load8S({ align: 0, memoryIndex: 0, offset: 0 })
    .i32Extend8S()
    .localSet(valueLocal)
    .localGet(0)
    .i32Load16U({ align: 1, memoryIndex: 0, offset: 0 })
    .i32Extend16S()
    .localSet(valueLocal)
    .localGet(0)
    .i32Load16S({ align: 1, memoryIndex: 0, offset: 0 })
    .localSet(valueLocal)
    .localGet(0)
    .localGet(1)
    .i32Store8({ align: 0, memoryIndex: 0, offset: 0 })
    .localGet(0)
    .localGet(1)
    .i32Store16({ align: 1, memoryIndex: 0, offset: 0 })
    .localGet(valueLocal);

  deepStrictEqual([...body.finish().bytes], [
    0x01, 0x01, 0x7f,
    0x20, 0x00, 0x2c, 0x00, 0x00, 0xc0, 0x21, 0x02,
    0x20, 0x00, 0x2f, 0x01, 0x00, 0xc1, 0x21, 0x02,
    0x20, 0x00, 0x2e, 0x01, 0x00, 0x21, 0x02,
    0x20, 0x00, 0x20, 0x01, 0x3a, 0x00, 0x00,
    0x20, 0x00, 0x20, 0x01, 0x3b, 0x01, 0x00,
    0x20, 0x02, 0x0b
  ]);
});
