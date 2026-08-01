import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { encodeWasmFunctionBody } from "#compiler/wasm/encoder/function-body.js";
import { wasmInstruction } from "#compiler/wasm/encoder/instructions.js";
import { wasmValueType } from "#compiler/wasm/encoder/types.js";

test("declared locals follow parameters in the Wasm local index space", () => {
  const body = encodeWasmFunctionBody(
    {
      parameterCount: 2,
      localTypes: [wasmValueType.i32, wasmValueType.i64]
    },
    (writer, resolveLocal) => {
      writer.write(wasmInstruction.i32.const, 7);
      writer.write(wasmInstruction.local.set, resolveLocal(0));
      writer.write(wasmInstruction.i64.const, 9n);
      writer.write(wasmInstruction.local.set, resolveLocal(1));
      writer.write(wasmInstruction.local.get, resolveLocal(0));
      writer.write(wasmInstruction.parametric.drop);
    }
  );

  // prettier-ignore
  deepStrictEqual([...body.bytes], [
    0x02, 0x01, 0x7f, 0x01, 0x7e,
    0x41, 0x07, 0x21, 0x02,
    0x42, 0x09, 0x21, 0x03,
    0x20, 0x02, 0x1a,
    0x0b
  ]);
});

test("br_table encodes its label vector and default depth", () => {
  const body = encodeWasmFunctionBody(
    {
      parameterCount: 1,
      localTypes: []
    },
    (writer) => {
      writer.write(wasmInstruction.control.block);
      writer.write(wasmInstruction.control.block);
      writer.write(wasmInstruction.control.block);
      writer.write(wasmInstruction.local.get, 0);
      writer.write(wasmInstruction.control.brTable, [1, 0], 2);
      writer.write(wasmInstruction.control.end);
      writer.write(wasmInstruction.i32.const, 20);
      writer.write(wasmInstruction.control.return);
      writer.write(wasmInstruction.control.end);
      writer.write(wasmInstruction.i32.const, 10);
      writer.write(wasmInstruction.control.return);
      writer.write(wasmInstruction.control.end);
      writer.write(wasmInstruction.i32.const, 30);
    }
  );

  // prettier-ignore
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
  const body = encodeWasmFunctionBody(
    {
      parameterCount: 2,
      localTypes: [wasmValueType.i32]
    },
    (writer, resolveLocal) => {
      const valueLocal = resolveLocal(0);

      writer.write(wasmInstruction.local.get, 0);
      writer.write(wasmInstruction.i32.load8S, { align: 0, memoryIndex: 0, offset: 0 });
      writer.write(wasmInstruction.i32.extend8S);
      writer.write(wasmInstruction.local.set, valueLocal);
      writer.write(wasmInstruction.local.get, 0);
      writer.write(wasmInstruction.i32.load16U, { align: 1, memoryIndex: 0, offset: 0 });
      writer.write(wasmInstruction.i32.extend16S);
      writer.write(wasmInstruction.local.set, valueLocal);
      writer.write(wasmInstruction.local.get, 0);
      writer.write(wasmInstruction.i32.load16S, { align: 1, memoryIndex: 0, offset: 0 });
      writer.write(wasmInstruction.local.set, valueLocal);
      writer.write(wasmInstruction.local.get, 0);
      writer.write(wasmInstruction.local.get, 1);
      writer.write(wasmInstruction.i32.store8, { align: 0, memoryIndex: 0, offset: 0 });
      writer.write(wasmInstruction.local.get, 0);
      writer.write(wasmInstruction.local.get, 1);
      writer.write(wasmInstruction.i32.store16, { align: 1, memoryIndex: 0, offset: 0 });
      writer.write(wasmInstruction.local.get, valueLocal);
    }
  );

  // prettier-ignore
  deepStrictEqual([...body.bytes], [
    0x01, 0x01, 0x7f,
    0x20, 0x00, 0x2c, 0x00, 0x00, 0xc0, 0x21, 0x02,
    0x20, 0x00, 0x2f, 0x01, 0x00, 0xc1, 0x21, 0x02,
    0x20, 0x00, 0x2e, 0x01, 0x00, 0x21, 0x02,
    0x20, 0x00, 0x20, 0x01, 0x3a, 0x00, 0x00,
    0x20, 0x00, 0x20, 0x01, 0x3b, 0x01, 0x00,
    0x20, 0x02, 0x0b
  ]);
});
