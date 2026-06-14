import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { decodeExit, encodeExit, ExitReason } from "#wasm/exit.js";

const importNamespace = "wasm86";
const tableImportName = "links";
const entryExportName = "entry";
const targetExportName = "target";
const cpuStatePtr = 32;

test("return_call_indirect_invokes_imported_table_target", async () => {
  const { instance, table } = await instantiateIndirectCallModule(returnCallIndirectEntryBody);

  table.set(0, exportedFunction(instance, targetExportName));

  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  deepStrictEqual(decodeExit(result), {
    exitReason: ExitReason.HOST_TRAP,
    payload: 0x2e
  });
});

test("call_indirect_invokes_imported_table_target", async () => {
  const { instance, table } = await instantiateIndirectCallModule(callIndirectEntryBody);

  table.set(0, exportedFunction(instance, targetExportName));

  const entry = exportedFunction(instance, entryExportName);
  const result = entry(cpuStatePtr);

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint result, got ${typeof result}`);
  }

  deepStrictEqual(decodeExit(result), {
    exitReason: ExitReason.HOST_TRAP,
    payload: 0x2e
  });
});

test("table_import_index_is_stable", () => {
  const module = new WasmModuleEncoder();
  const tableIndex = module.importTable(importNamespace, tableImportName, { minElements: 1 });

  strictEqual(tableIndex, 0);
});

test("table_import_uses_funcref", () => {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(encodeIndirectCallModule(returnCallIndirectEntryBody)));

  deepStrictEqual(imports[0], {
    module: importNamespace,
    name: tableImportName,
    kind: "table"
  });
});

async function instantiateIndirectCallModule(
  entryBody: (blockType: number, tableIndex: number) => WasmFunctionBodyEncoder
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
  entryBody: (blockType: number, tableIndex: number) => WasmFunctionBodyEncoder
): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const tableIndex = module.importTable(importNamespace, tableImportName, { minElements: 1 });
  const blockType = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i64]
  });
  const targetIndex = module.addFunction(
    blockType,
    new WasmFunctionBodyEncoder(1)
      .i64Const(encodeExit(ExitReason.HOST_TRAP, 0x2e))
      .end()
  );
  const entryIndex = module.addFunction(blockType, entryBody(blockType, tableIndex));

  module.exportFunction(targetExportName, targetIndex);
  module.exportFunction(entryExportName, entryIndex);

  return module.encode();
}

function returnCallIndirectEntryBody(blockType: number, tableIndex: number): WasmFunctionBodyEncoder {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .i32Const(0)
    .returnCallIndirect(blockType, tableIndex)
    .end();
}

function callIndirectEntryBody(blockType: number, tableIndex: number): WasmFunctionBodyEncoder {
  return new WasmFunctionBodyEncoder(1)
    .localGet(0)
    .i32Const(0)
    .callIndirect(blockType, tableIndex)
    .end();
}

function exportedFunction(instance: WebAssembly.Instance, name: string): (...args: number[]) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as (...args: number[]) => unknown;
}
