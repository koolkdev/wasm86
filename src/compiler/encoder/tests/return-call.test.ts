import { strictEqual } from "node:assert";
import { test } from "node:test";

import {
  encodeWasmFunctionBody,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { wasmInstruction } from "#compiler/encoder/instructions.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-fixture.js";
import { wasmValueType } from "#compiler/encoder/types.js";

const entryExportName = "entry";
const importModuleName = "wasm86";
const cpuStateMemoryName = "cpuState";
const guestMemoryName = "guest";
const cpuStatePtr = 32;
const statePayloadOffset = 0;
const u32Align = 2;
const forwardedResult = 0x1234_5678_9abc_def0n;
const statePayloadPrefix = 0x3456_789a_0000_0000n;

test("return_call forwards a result from another function", async () => {
  const instance = await instantiateReturnCallModule(constantTargetBody(forwardedResult));
  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  strictEqual(result, forwardedResult);
});

test("return_call forwards the CPU state pointer", async () => {
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
  return encodeWasmFunctionBody({
    parameterCount: 1,
    localTypes: []
  }, (writer) => {
    writer.write(wasmInstruction.local.get, 0);
    writer.write(wasmInstruction.returnCall.direct, targetFunctionIndex);
  });
}

function constantTargetBody(result: bigint): EncodedWasmFunctionBody {
  return encodeWasmFunctionBody({
    parameterCount: 1,
    localTypes: []
  }, (writer) => {
    writer.write(wasmInstruction.i64.const, result);
  });
}

function statePayloadTargetBody(): EncodedWasmFunctionBody {
  return encodeWasmFunctionBody({
    parameterCount: 1,
    localTypes: []
  }, (writer) => {
    writer.write(wasmInstruction.local.get, 0);
    writer.write(wasmInstruction.i32.load, {
      align: u32Align,
      memoryIndex: 0,
      offset: statePayloadOffset
    });
    writer.write(wasmInstruction.i64.extendI32U);
    writer.write(wasmInstruction.i64.const, statePayloadPrefix);
    writer.write(wasmInstruction.i64.or);
  });
}

function exportedFunction(instance: WebAssembly.Instance, name: string): (cpuStatePtr: number) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (cpuStatePtr: number) => unknown;
}
