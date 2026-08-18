import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { functionType } from "#compiler/function/type.js";
import { Integer } from "#compiler/function/values.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef } from "#compiler/reference.js";
import { toWasmFunctionType } from "#compiler/wasm/type-mapping.js";
import { indexWasmModule } from "../indices.js";
import type { WasmModulePlan } from "../plan.js";
import { plannedFunction } from "./function-plan-fixture.js";

test("module indices canonicalize structural types and fix Wasm index-space order", () => {
  const firstType = functionType([Integer[32]], [Integer[32]]);
  const secondType = functionType([Integer[32]], [Integer[32]]);
  const importedType = functionType([], [Integer[64]]);
  const importedRef = functionRef("test.wasm-module.indices.imported");
  const firstRef = functionRef("test.wasm-module.indices.first");
  const secondRef = functionRef("test.wasm-module.indices.second");
  const first = plannedFunction(firstRef, firstType, (fn) => {
    const [value] = fn.parameters;

    fn.return([value]);
  });
  const second = plannedFunction(secondRef, secondType, (fn) => {
    const [value] = fn.parameters;

    fn.return([value]);
  });
  const plan: WasmModulePlan = {
    memoryImports: [],
    functionImports: [
      {
        ref: importedRef,
        type: toWasmFunctionType(importedType),
        moduleName: "env",
        name: "imported"
      }
    ],
    functions: [first, second],
    exports: [
      {
        ref: functionExportRef("test.wasm-module.indices.second-export"),
        name: "second",
        target: secondRef
      },
      {
        ref: functionExportRef("test.wasm-module.indices.first-export"),
        name: "first",
        target: firstRef
      }
    ]
  };
  const indices = indexWasmModule(plan);

  deepStrictEqual(indices.functionTypes, [
    { parameters: ["i32"], results: ["i32"] },
    { parameters: [], results: ["i64"] }
  ]);
  strictEqual(indices.functionTypeIndices.get({ parameters: ["i32"], results: ["i32"] }), 0);
  strictEqual(indices.functionIndices.get(importedRef), 0);
  strictEqual(indices.functionIndices.get(firstRef), 1);
  strictEqual(indices.functionIndices.get(secondRef), 2);
  deepStrictEqual(
    indices.functionExports.map(({ name, functionIndex }) => ({ name, functionIndex })),
    [
      { name: "second", functionIndex: 2 },
      { name: "first", functionIndex: 1 }
    ]
  );
});
