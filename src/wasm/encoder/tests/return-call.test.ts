import { deepStrictEqual, match, strictEqual } from "node:assert";
import { test } from "node:test";

import { stateOffset, wasmImport } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { decodeExit, encodeExit, ExitReason } from "#wasm/exit.js";

const entryExportName = "entry";
const statePtr = 32;
const u32Align = 2;

test("return_call_two_function_smoke_test", async () => {
  const instance = await instantiateReturnCallModule(constantTargetBody(ExitReason.HOST_TRAP, 0x2e));
  const entry = exportedFunction(instance, entryExportName);
  const result = entry(statePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  deepStrictEqual(decodeExit(result), {
    exitReason: ExitReason.HOST_TRAP,
    payload: 0x2e
  });
});

test("return_call_result_reaches_typescript_once", async () => {
  const instance = await instantiateReturnCallModule(constantTargetBody(ExitReason.DYNAMIC_JUMP, 0x1234));
  const entry = exportedFunction(instance, entryExportName);
  const result = entry(statePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  deepStrictEqual(decodeExit(result), {
    exitReason: ExitReason.DYNAMIC_JUMP,
    payload: 0x1234
  });
});

test("return_call_preserves_state_memory_abi", async () => {
  const stateMemory = new WebAssembly.Memory({ initial: 1 });
  const instance = await instantiateReturnCallModule(statePayloadTargetBody(), stateMemory);
  const stateView = new DataView(stateMemory.buffer);

  stateView.setUint32(statePtr + stateOffset.eax, 0xfeed_cafe, true);

  const entry = exportedFunction(instance, entryExportName);
  const result = entry(statePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  deepStrictEqual(decodeExit(result), {
    exitReason: ExitReason.DYNAMIC_JUMP,
    payload: 0xfeed_cafe
  });
});

test("return_call_same_signature_required", async () => {
  const result = await compileForTest(encodeMismatchedReturnCallModule());

  strictEqual(result.ok, false);
  match(result.message, /return_call|signature|type|i64|i32|expected/i);
});

async function instantiateReturnCallModule(
  targetBody: WasmFunctionBodyEncoder,
  stateMemory = new WebAssembly.Memory({ initial: 1 })
): Promise<WebAssembly.Instance> {
  const module = await WebAssembly.compile(encodeReturnCallModule(targetBody));
  const guestMemory = new WebAssembly.Memory({ initial: 1 });

  return WebAssembly.instantiate(module, {
    [wasmImport.moduleName]: {
      [wasmImport.stateMemoryName]: stateMemory,
      [wasmImport.guestMemoryName]: guestMemory
    }
  });
}

function encodeReturnCallModule(targetBody: WasmFunctionBodyEncoder): Uint8Array<ArrayBuffer> {
  const module = moduleWithMemories();
  const blockType = addBlockFunctionType(module);
  const targetIndex = module.addFunction(blockType, targetBody);
  const entryIndex = module.addFunction(blockType, returnCallEntryBody(targetIndex));

  module.exportFunction(entryExportName, entryIndex);

  return module.encode();
}

function encodeMismatchedReturnCallModule(): Uint8Array<ArrayBuffer> {
  const module = moduleWithMemories();
  const entryType = addBlockFunctionType(module);
  const targetType = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const targetIndex = module.addFunction(targetType, new WasmFunctionBodyEncoder(1).i32Const(1).end());
  const entryIndex = module.addFunction(entryType, returnCallEntryBody(targetIndex));

  module.exportFunction(entryExportName, entryIndex);

  return module.encode();
}

function moduleWithMemories(): WasmModuleEncoder {
  const module = new WasmModuleEncoder();

  module.importMemory(wasmImport.moduleName, wasmImport.stateMemoryName, { minPages: 1 });
  module.importMemory(wasmImport.moduleName, wasmImport.guestMemoryName, { minPages: 1 });

  return module;
}

function addBlockFunctionType(module: WasmModuleEncoder): number {
  return module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i64]
  });
}

function returnCallEntryBody(targetFunctionIndex: number): WasmFunctionBodyEncoder {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .returnCallFunction(targetFunctionIndex)
    .end();
}

function constantTargetBody(exitReason: ExitReason, payload: number): WasmFunctionBodyEncoder {
  return new WasmFunctionBodyEncoder(1)
    .i64Const(encodeExit(exitReason, payload))
    .end();
}

function statePayloadTargetBody(): WasmFunctionBodyEncoder {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .i32Load({
      align: u32Align,
      memoryIndex: 0,
      offset: stateOffset.eax
    })
    .i64ExtendI32U()
    .i64Const(encodeExit(ExitReason.DYNAMIC_JUMP, 0))
    .i64Or()
    .end();
}

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

function exportedFunction(instance: WebAssembly.Instance, name: string): (statePtr: number) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (statePtr: number) => unknown;
}
