import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmImport } from "#wasm/abi.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import {
  defineLazyFlagHelper,
  defineLazyFlagHelpers,
  lazyFlagHelperName
} from "#wasm/helpers/lazy-flags.js";
import { createWasmHelperRegistry } from "#wasm/helpers/module.js";

test("lazy flag helper names are stable", () => {
  strictEqual(lazyFlagHelperName("CF"), "resolveCF");
  strictEqual(lazyFlagHelperName("ZF"), "resolveZF");
});

test("lazy flag helper definitions use status flag order", () => {
  const module = moduleWithCpuMemory();
  const registry = createWasmHelperRegistry(module);

  defineLazyFlagHelpers(registry, ["ZF", "CF"]);

  strictEqual(registry.functionIndex({ kind: "lazyFlag", flag: "CF" }), 0);
  strictEqual(registry.functionIndex({ kind: "lazyFlag", flag: "ZF" }), 1);
  deepStrictEqual(registry.helpers(), [
    { kind: "lazyFlag", flag: "CF" },
    { kind: "lazyFlag", flag: "ZF" }
  ]);
});

test("lazy flag helper bodies compile", async () => {
  const module = moduleWithCpuMemory();
  const registry = createWasmHelperRegistry(module);

  defineLazyFlagHelper(registry, "ZF");

  await WebAssembly.compile(module.encode());
});

function moduleWithCpuMemory(): WasmModuleEncoder {
  const module = new WasmModuleEncoder();

  module.importMemory(wasmImport.namespace, wasmImport.cpuStateMemoryName, { minPages: 1 });
  return module;
}
