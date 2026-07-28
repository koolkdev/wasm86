import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { encodeWasmFunctionBody } from "#compiler/encoder/function-body.js";
import { wasmInstruction } from "#compiler/encoder/instructions.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-fixture.js";
import { wasmValueType } from "#compiler/encoder/types.js";

const importModuleName = "host";
const importFunctionName = "increment";

test("function imports prefix defined indexes and direct calls", async () => {
  const bytes = encodeTestModule({
    functionTypes: [
      {
        params: [wasmValueType.i32],
        results: [wasmValueType.i32]
      }
    ],
    functionImports: [
      {
        moduleName: importModuleName,
        name: importFunctionName,
        typeIndex: 0
      }
    ],
    functions: [
      {
        typeIndex: 0,
        body: encodeWasmFunctionBody(
          {
            parameterCount: 1,
            localTypes: []
          },
          (writer) => {
            writer.write(wasmInstruction.local.get, 0);
            writer.write(wasmInstruction.call.direct, 0);
            writer.write(wasmInstruction.i32.const, 1);
            writer.write(wasmInstruction.i32.add);
          }
        )
      },
      {
        typeIndex: 0,
        body: encodeWasmFunctionBody(
          {
            parameterCount: 1,
            localTypes: []
          },
          (writer) => {
            writer.write(wasmInstruction.local.get, 0);
            writer.write(wasmInstruction.returnCall.direct, 0);
          }
        )
      }
    ],
    functionExports: [
      { name: "ordinary", functionIndex: 1 },
      { name: "returned", functionIndex: 2 }
    ]
  });
  const compiled = new WebAssembly.Module(bytes);

  deepStrictEqual(WebAssembly.Module.imports(compiled), [
    {
      module: importModuleName,
      name: importFunctionName,
      kind: "function"
    }
  ]);

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
    functionImports: [
      {
        moduleName: importModuleName,
        name: importFunctionName,
        typeIndex: 0
      }
    ],
    functions: [
      {
        typeIndex: 0,
        body: encodeWasmFunctionBody(
          {
            parameterCount: 0,
            localTypes: []
          },
          () => {}
        )
      },
      {
        typeIndex: 0,
        body: encodeWasmFunctionBody(
          {
            parameterCount: 0,
            localTypes: []
          },
          (writer) => {
            writer.write(wasmInstruction.i32.const, 1);
            writer.write(wasmInstruction.control.if, { hint: "likely" });
            writer.write(wasmInstruction.control.end);
          }
        )
      }
    ]
  });
  const compiled = new WebAssembly.Module(bytes);
  const sections = WebAssembly.Module.customSections(compiled, "metadata.code.branch_hint");

  strictEqual(sections.length, 1);
  const section = sections[0];

  if (section === undefined) {
    throw new Error("missing branch-hint section");
  }
  // prettier-ignore
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
