import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-fixture.js";
import { wasmValueType } from "#compiler/encoder/types.js";

const importModuleName = "host";
const importFunctionName = "increment";

test("function imports prefix defined indexes and direct calls", async () => {
  const bytes = encodeTestModule({
    functionTypes: [{
      params: [wasmValueType.i32],
      results: [wasmValueType.i32]
    }],
    functionImports: [{
      moduleName: importModuleName,
      name: importFunctionName,
      typeIndex: 0
    }],
    functions: [
      {
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder(1)
          .localGet(0)
          .callFunction(0)
          .i32Const(1)
          .i32Add()
          .finish()
      },
      {
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder(1)
          .localGet(0)
          .returnCallFunction(0)
          .finish()
      }
    ],
    functionExports: [
      { name: "ordinary", functionIndex: 1 },
      { name: "returned", functionIndex: 2 }
    ]
  });
  const compiled = new WebAssembly.Module(bytes);

  deepStrictEqual(WebAssembly.Module.imports(compiled), [{
    module: importModuleName,
    name: importFunctionName,
    kind: "function"
  }]);

  const instance = await WebAssembly.instantiate(compiled, {
    [importModuleName]: {
      [importFunctionName]: (value: number): number => value + 1
    }
  });
  const ordinary = exportedFunction(instance, "ordinary");
  const returned = exportedFunction(instance, "returned");

  strictEqual(ordinary(41), 43);
  strictEqual(returned(41), 42);
});

test("branch hints use imported-function-prefixed indexes", () => {
  const bytes = encodeTestModule({
    functionTypes: [{ params: [], results: [] }],
    functionImports: [{
      moduleName: importModuleName,
      name: importFunctionName,
      typeIndex: 0
    }],
    functions: [
      { typeIndex: 0, body: new WasmFunctionBodyEncoder().finish() },
      {
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder()
          .i32Const(1)
          .ifBlock({ hint: "likely" })
          .endBlock()
          .finish()
      }
    ]
  });
  const compiled = new WebAssembly.Module(bytes);
  const sections = WebAssembly.Module.customSections(
    compiled,
    "metadata.code.branch_hint"
  );

  strictEqual(sections.length, 1);
  const section = sections[0];

  if (section === undefined) {
    throw new Error("missing branch-hint section");
  }
  deepStrictEqual([...new Uint8Array(section)], [
    0x01,
    0x02,
    0x01,
    0x03,
    0x01,
    0x01
  ]);
});

function exportedFunction(
  instance: WebAssembly.Instance,
  name: string
): (...args: number[]) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }
  return value as (...args: number[]) => unknown;
}
