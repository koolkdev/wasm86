import { match, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-description.js";
import { wasmOpcode, wasmValueType } from "#compiler/encoder/types.js";
import { wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";

test("constant i64 function compiles", async () => {
  const bytes = encodeConstantI64TestModule("constant", 0x0006_0000_1234_5678n);

  const module = await WebAssembly.compile(bytes);

  ok(module instanceof WebAssembly.Module);
});

test("constant i64 function returns bigint", async () => {
  const expected = 0x0006_0000_1234_5678n;
  const bytes = encodeConstantI64TestModule("constant", expected);

  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module);
  const constant = instance.exports.constant;

  if (typeof constant !== "function") {
    throw new Error("expected exported function 'constant'");
  }

  const result: unknown = constant();

  strictEqual(typeof result, "bigint");
  strictEqual(result, expected);
});

test("bad module bytes fail cleanly", async () => {
  const result = await compileForTest(new Uint8Array([0x00, 0x61, 0x73, 0x6d]));

  strictEqual(result.ok, false);
  match(result.message, /WebAssembly\.compile|expected|section|version|short|magic/i);
});

test("branch hint metadata section compiles", async () => {
  const module = await WebAssembly.compile(encodeHintedIfTestModule());
  const sections = WebAssembly.Module.customSections(module, "metadata.code.branch_hint");

  strictEqual(sections.length, 1);
});

test("module preserves encoded function branch hints", async () => {
  const body = new WasmFunctionBodyEncoder()
    .i32Const(0)
    .ifBlock({ hint: "unlikely" })
    .endBlock()
    .i32Const(42)
    .finish();
  const compiled = await WebAssembly.compile(encodeTestModule({
    functionTypes: [{ params: [], results: [wasmValueType.i32] }],
    functions: [{ typeIndex: 0, body }],
    functionExports: [{ name: "entry", functionIndex: 0 }]
  }));
  const sections = WebAssembly.Module.customSections(compiled, "metadata.code.branch_hint");
  const instance = await WebAssembly.instantiate(compiled);
  const entry = instance.exports.entry;

  if (typeof entry !== "function") {
    throw new Error("expected exported function 'entry'");
  }

  strictEqual(entry(), 42);
  strictEqual(sections.length, 1);
});

test("br_table dispatch compiles and branches by i32 selector", async () => {
  const module = await WebAssembly.compile(encodeBrTableTestModule());
  const instance = await WebAssembly.instantiate(module);
  const select = instance.exports.select;

  if (typeof select !== "function") {
    throw new Error("expected exported function 'select'");
  }

  strictEqual(select(0), 10);
  strictEqual(select(1), 20);
  strictEqual(select(2), 30);
});

test("typed if expression compiles and returns branch values", async () => {
  const module = await WebAssembly.compile(encodeTypedIfTestModule());
  const instance = await WebAssembly.instantiate(module);
  const select = instance.exports.select;

  if (typeof select !== "function") {
    throw new Error("expected exported function 'select'");
  }

  strictEqual(select(0), 20);
  strictEqual(select(1), 10);
});

test("i32 signed and unsigned narrow memory and sign-extension opcodes compile", async () => {
  const body = encodeWidthMemoryOpcodeBody();
  const bytes = encodeWidthMemoryOpcodeModule(body);

  await WebAssembly.compile(bytes);

  const opcodes = wasmBodyOpcodes(body.bytes);

  strictEqual(opcodes.includes(wasmOpcode.i32Load8S), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load16U), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load16S), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Store8), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Store16), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Extend8S), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Extend16S), true);
});

type CompileResult =
  | Readonly<{ ok: true; module: WebAssembly.Module }>
  | Readonly<{ ok: false; message: string }>;

async function compileForTest(bytes: Uint8Array<ArrayBuffer>): Promise<CompileResult> {
  try {
    return {
      ok: true,
      module: await WebAssembly.compile(bytes)
    };
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function encodeConstantI64TestModule(exportName: string, value: bigint): Uint8Array<ArrayBuffer> {
  const body = new WasmFunctionBodyEncoder().i64Const(value).finish();

  return encodeTestModule({
    functionTypes: [{ params: [], results: [wasmValueType.i64] }],
    functions: [{ typeIndex: 0, body }],
    functionExports: [{ name: exportName, functionIndex: 0 }]
  });
}

function encodeHintedIfTestModule(): Uint8Array<ArrayBuffer> {
  const body = new WasmFunctionBodyEncoder()
    .i32Const(0)
    .ifBlock({ hint: "unlikely" })
    .endBlock()
    .i32Const(1)
    .finish();
  return encodeTestModule({
    functionTypes: [{ params: [], results: [wasmValueType.i32] }],
    functions: [{ typeIndex: 0, body }],
    functionExports: [{ name: "hintedIf", functionIndex: 0 }]
  });
}

function encodeBrTableTestModule(): Uint8Array<ArrayBuffer> {
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
  return encodeTestModule({
    functionTypes: [{
      params: [wasmValueType.i32],
      results: [wasmValueType.i32]
    }],
    functions: [{ typeIndex: 0, body }],
    functionExports: [{ name: "select", functionIndex: 0 }]
  });
}

function encodeTypedIfTestModule(): Uint8Array<ArrayBuffer> {
  const body = new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .ifBlock({ result: wasmValueType.i32 })
    .i32Const(10)
    .elseBlock()
    .i32Const(20)
    .endBlock()
    .finish();
  return encodeTestModule({
    functionTypes: [{
      params: [wasmValueType.i32],
      results: [wasmValueType.i32]
    }],
    functions: [{ typeIndex: 0, body }],
    functionExports: [{ name: "select", functionIndex: 0 }]
  });
}

function encodeWidthMemoryOpcodeModule(body: EncodedWasmFunctionBody): Uint8Array<ArrayBuffer> {
  return encodeTestModule({
    functionTypes: [{
      params: [wasmValueType.i32, wasmValueType.i32],
      results: [wasmValueType.i32]
    }],
    memoryImports: [{ moduleName: "env", name: "memory", limits: { minPages: 1 } }],
    functions: [{ typeIndex: 0, body }],
    functionExports: [{ name: "run", functionIndex: 0 }]
  });
}

function encodeWidthMemoryOpcodeBody(): EncodedWasmFunctionBody {
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

  return body.finish();
}
