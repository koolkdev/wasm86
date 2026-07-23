import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-description.js";
import { wasmValueType } from "#compiler/encoder/types.js";

const importModuleName = "wasm86";
const entryExportName = "entry";
const cpuStateMemoryName = "cpuState";
const guestMemoryName = "guest";
const cpuStatePtr = 32;
const forwardedResult = 0x1234_5678_9abc_def0n;

test("an exported entry calls an internal function", async () => {
  const instance = await instantiateTwoFunctionModule();
  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  strictEqual(result, forwardedResult);
});

test("CPU state remains memory import 0", () => {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(encodeTwoFunctionModule()));

  deepStrictEqual(imports[0], {
    module: importModuleName,
    name: cpuStateMemoryName,
    kind: "memory"
  });
});

test("guest memory remains memory import 1", () => {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(encodeTwoFunctionModule()));

  deepStrictEqual(imports[1], {
    module: importModuleName,
    name: guestMemoryName,
    kind: "memory"
  });
});

async function instantiateTwoFunctionModule(): Promise<WebAssembly.Instance> {
  const module = await WebAssembly.compile(encodeTwoFunctionModule());
  const cpuStateMemory = new WebAssembly.Memory({ initial: 1 });
  const guestMemory = new WebAssembly.Memory({ initial: 1 });
  const instance = await WebAssembly.instantiate(module, {
    [importModuleName]: {
      [cpuStateMemoryName]: cpuStateMemory,
      [guestMemoryName]: guestMemory
    }
  });

  return instance;
}

function encodeTwoFunctionModule(): Uint8Array<ArrayBuffer> {
  return encodeTestModule({
    functionTypes: [{
      params: [wasmValueType.i32],
      results: [wasmValueType.i64]
    }],
    memoryImports: [
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
    ],
    functions: [
      { typeIndex: 0, body: helperBody() },
      { typeIndex: 0, body: entryBody(0) }
    ],
    functionExports: [{ name: entryExportName, functionIndex: 1 }]
  });
}

function helperBody(): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .i64Const(forwardedResult)
    .finish();
}

function entryBody(targetFunctionIndex: number): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .callFunction(targetFunctionIndex)
    .finish();
}

function exportedFunction(instance: WebAssembly.Instance, name: string): (cpuStatePtr: number) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (cpuStatePtr: number) => unknown;
}
