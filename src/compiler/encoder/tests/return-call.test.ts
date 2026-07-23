import { match, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-description.js";
import { wasmValueType } from "#compiler/encoder/types.js";

const entryExportName = "entry";
const importModuleName = "wasm86";
const cpuStateMemoryName = "cpuState";
const guestMemoryName = "guest";
const cpuStatePtr = 32;
const statePayloadOffset = 0;
const u32Align = 2;
const forwardedResult = 0x1234_5678_9abc_def0n;
const typescriptResult = 0x2345_6789_abcd_ef01n;
const statePayloadPrefix = 0x3456_789a_0000_0000n;

test("return_call_two_function_smoke_test", async () => {
  const instance = await instantiateReturnCallModule(constantTargetBody(forwardedResult));
  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  strictEqual(result, forwardedResult);
});

test("return_call_result_reaches_typescript_once", async () => {
  const instance = await instantiateReturnCallModule(constantTargetBody(typescriptResult));
  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  strictEqual(result, typescriptResult);
});

test("return_call_preserves_cpu_state_memory_abi", async () => {
  const cpuStateMemory = new WebAssembly.Memory({ initial: 1 });
  const instance = await instantiateReturnCallModule(statePayloadTargetBody(), cpuStateMemory);
  const stateView = new DataView(cpuStateMemory.buffer);

  stateView.setUint32(cpuStatePtr + statePayloadOffset, 0xfeed_cafe, true);

  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  strictEqual(result, statePayloadPrefix | 0xfeed_cafen);
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
    [importModuleName]: {
      [cpuStateMemoryName]: cpuStateMemory,
      [guestMemoryName]: guestMemory
    }
  });
}

function encodeReturnCallModule(targetBody: EncodedWasmFunctionBody): Uint8Array<ArrayBuffer> {
  return encodeTestModule({
    functionTypes: [{
      params: [wasmValueType.i32],
      results: [wasmValueType.i64]
    }],
    memoryImports: moduleMemoryImports(),
    functions: [
      { typeIndex: 0, body: targetBody },
      { typeIndex: 0, body: returnCallEntryBody(0) }
    ],
    functionExports: [{ name: entryExportName, functionIndex: 1 }]
  });
}

function encodeMismatchedReturnCallModule(): Uint8Array<ArrayBuffer> {
  return encodeTestModule({
    functionTypes: [
      { params: [wasmValueType.i32], results: [wasmValueType.i64] },
      { params: [wasmValueType.i32], results: [wasmValueType.i32] }
    ],
    memoryImports: moduleMemoryImports(),
    functions: [
      {
        typeIndex: 1,
        body: new WasmFunctionBodyEncoder(1).i32Const(1).finish()
      },
      { typeIndex: 0, body: returnCallEntryBody(0) }
    ],
    functionExports: [{ name: entryExportName, functionIndex: 1 }]
  });
}

function moduleMemoryImports() {
  return [
    {
      moduleName: importModuleName,
      name: cpuStateMemoryName,
      limits: { minPages: 1 }
    },
    {
      moduleName: importModuleName,
      name: guestMemoryName,
      limits: { minPages: 1 }
    }
  ];
}

function returnCallEntryBody(targetFunctionIndex: number): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .returnCallFunction(targetFunctionIndex)
    .finish();
}

function constantTargetBody(result: bigint): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .i64Const(result)
    .finish();
}

function statePayloadTargetBody(): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .i32Load({
      align: u32Align,
      memoryIndex: 0,
      offset: statePayloadOffset
    })
    .i64ExtendI32U()
    .i64Const(statePayloadPrefix)
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
