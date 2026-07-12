import { deepStrictEqual, match, strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmImport } from "#wasm/abi.js";
import { WASM_CPU_STATE_OFFSETS } from "#wasm/cpu-state-layout.js";
import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmValueType } from "#compiler/encoder/types.js";
import { CompletionExit, decodeExit, encodeCompletionExit, encodeHostExit, HostExit } from "#wasm/exit.js";

const entryExportName = "entry";
const cpuStatePtr = 32;
const u32Align = 2;

test("return_call_two_function_smoke_test", async () => {
  const instance = await instantiateReturnCallModule(constantHostTargetBody(HostExit.TRAP, 0x2e));
  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  deepStrictEqual(decodeExit(result), {
    family: "host",
    reason: HostExit.TRAP,
    payload: 0x2e
  });
});

test("return_call_result_reaches_typescript_once", async () => {
  const instance = await instantiateReturnCallModule(constantCompletionTargetBody(CompletionExit.DYNAMIC_JUMP, 0x1234));
  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  deepStrictEqual(decodeExit(result), {
    family: "completion",
    reason: CompletionExit.DYNAMIC_JUMP,
    payload: 0x1234
  });
});

test("return_call_preserves_cpu_state_memory_abi", async () => {
  const cpuStateMemory = new WebAssembly.Memory({ initial: 1 });
  const instance = await instantiateReturnCallModule(statePayloadTargetBody(), cpuStateMemory);
  const stateView = new DataView(cpuStateMemory.buffer);

  stateView.setUint32(cpuStatePtr + WASM_CPU_STATE_OFFSETS.eax, 0xfeed_cafe, true);

  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  deepStrictEqual(decodeExit(result), {
    family: "completion",
    reason: CompletionExit.DYNAMIC_JUMP,
    payload: 0xfeed_cafe
  });
});

test("return_call_same_signature_required", async () => {
  const result = await compileForTest(encodeMismatchedReturnCallModule());

  strictEqual(result.ok, false);
  match(result.message, /return_call|signature|type|i64|i32|expected/i);
});

async function instantiateReturnCallModule(
  targetBody: EncodedWasmFunctionBody,
  cpuStateMemory = new WebAssembly.Memory({ initial: 1 })
): Promise<WebAssembly.Instance> {
  const module = await WebAssembly.compile(encodeReturnCallModule(targetBody));
  const guestMemory = new WebAssembly.Memory({ initial: 1 });

  return WebAssembly.instantiate(module, {
    [wasmImport.namespace]: {
      [wasmImport.cpuStateMemoryName]: cpuStateMemory,
      [wasmImport.guestMemoryName]: guestMemory
    }
  });
}

function encodeReturnCallModule(targetBody: EncodedWasmFunctionBody): Uint8Array<ArrayBuffer> {
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
  const targetIndex = module.addFunction(targetType, new WasmFunctionBodyEncoder(1).i32Const(1).finish());
  const entryIndex = module.addFunction(entryType, returnCallEntryBody(targetIndex));

  module.exportFunction(entryExportName, entryIndex);

  return module.encode();
}

function moduleWithMemories(): WasmModuleEncoder {
  const module = new WasmModuleEncoder();

  module.importMemory(wasmImport.namespace, wasmImport.cpuStateMemoryName, { minPages: 1 });
  module.importMemory(wasmImport.namespace, wasmImport.guestMemoryName, { minPages: 1 });

  return module;
}

function addBlockFunctionType(module: WasmModuleEncoder): number {
  return module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i64]
  });
}

function returnCallEntryBody(targetFunctionIndex: number): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .returnCallFunction(targetFunctionIndex)
    .finish();
}

function constantHostTargetBody(reason: HostExit, payload: number): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .i64Const(encodeHostExit(reason, payload))
    .finish();
}

function constantCompletionTargetBody(reason: CompletionExit, payload: number): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .i64Const(encodeCompletionExit(reason, payload))
    .finish();
}

function statePayloadTargetBody(): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .i32Load({
      align: u32Align,
      memoryIndex: 0,
      offset: WASM_CPU_STATE_OFFSETS.eax
    })
    .i64ExtendI32U()
    .i64Const(encodeCompletionExit(CompletionExit.DYNAMIC_JUMP, 0))
    .i64Or()
    .finish();
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

function exportedFunction(instance: WebAssembly.Instance, name: string): (cpuStatePtr: number) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (cpuStatePtr: number) => unknown;
}
