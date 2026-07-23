import { throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { testModuleDescription } from "#compiler/encoder/tests/module-description.js";
import { validateModuleDescription } from "#compiler/encoder/validate.js";

test("rejects a defined function with an unresolved type index", () => {
  throws(
    () => validateModuleDescription(testModuleDescription({
      functions: [{
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder().finish()
      }]
    })),
    /unknown Wasm function type index/
  );
});

test("rejects a function import with an unresolved type index", () => {
  throws(
    () => validateModuleDescription(testModuleDescription({
      functionImports: [{
        moduleName: "host",
        name: "callback",
        typeIndex: 0
      }]
    })),
    /unknown Wasm function type index/
  );
});

test("rejects a function export with an unresolved function index", () => {
  throws(
    () => validateModuleDescription(testModuleDescription({
      functionExports: [{ name: "missing", functionIndex: 0 }]
    })),
    /unknown Wasm function index/
  );
});

test("rejects invalid memory and table limits", () => {
  throws(
    () => validateModuleDescription(testModuleDescription({
      memoryImports: [{
        moduleName: "host",
        name: "memory",
        limits: { minPages: 2, maxPages: 1 }
      }]
    })),
    /memory maximum pages/
  );
  throws(
    () => validateModuleDescription(testModuleDescription({
      tableImports: [{
        moduleName: "host",
        name: "table",
        limits: { minElements: 2, maxElements: 1 }
      }]
    })),
    /table maximum elements/
  );
});
