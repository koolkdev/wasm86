import { strictEqual } from "node:assert";
import { test } from "node:test";

import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-fixture.js";
import { wasmValueType } from "#compiler/encoder/types.js";

const importNamespace = "wasm86";
const tableImportName = "links";
const entryExportName = "entry";
const targetExportName = "target";
const cpuStatePtr = 32;
const forwardedResult = 0x4567_89ab_cdef_0123n;

test("return_call_indirect invokes an imported table target", async () => {
  const { instance, table } = await instantiateIndirectCallModule(returnCallIndirectEntryBody);

  table.set(0, exportedFunction(instance, targetExportName));

  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  strictEqual(result, forwardedResult);
});

test("call_indirect invokes an imported table target", async () => {
  const { instance, table } = await instantiateIndirectCallModule(callIndirectEntryBody);

  table.set(0, exportedFunction(instance, targetExportName));

  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  strictEqual(result, forwardedResult);
});

async function instantiateIndirectCallModule(
  entryBody: (blockType: number, tableIndex: number) => EncodedWasmFunctionBody
): Promise<Readonly<{ instance: WebAssembly.Instance; table: WebAssembly.Table }>> {
  const module = await WebAssembly.compile(encodeIndirectCallModule(entryBody));
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const instance = await WebAssembly.instantiate(module, {
    [importNamespace]: {
      [tableImportName]: table
    }
  });

  return { instance, table };
}

function encodeIndirectCallModule(
  entryBody: (blockType: number, tableIndex: number) => EncodedWasmFunctionBody
): Uint8Array<ArrayBuffer> {
  return encodeTestModule({
    functionTypes: [{
      params: [wasmValueType.i32],
      results: [wasmValueType.i64]
    }],
    tableImports: [{
      moduleName: importNamespace,
      name: tableImportName,
      limits: { minElements: 1 }
    }],
    functions: [
      {
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder(1)
          .i64Const(forwardedResult)
          .finish()
      },
      { typeIndex: 0, body: entryBody(0, 0) }
    ],
    functionExports: [
      { name: targetExportName, functionIndex: 0 },
      { name: entryExportName, functionIndex: 1 }
    ]
  });
}

function returnCallIndirectEntryBody(blockType: number, tableIndex: number): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .i32Const(0)
    .returnCallIndirect(blockType, tableIndex)
    .finish();
}

function callIndirectEntryBody(blockType: number, tableIndex: number): EncodedWasmFunctionBody {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .i32Const(0)
    .callIndirect(blockType, tableIndex)
    .finish();
}

function exportedFunction(instance: WebAssembly.Instance, name: string): (...args: number[]) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (...args: number[]) => unknown;
}
