import { emitWasmFunctionBody } from "#compiler/wasm/emit/function.js";
import { encodeWasmModule, type WasmModuleDescription } from "#wasm/encoder/module.js";
import { createModuleBindings } from "./bindings.js";
import type { ModuleIndices } from "./indices.js";
import type { WasmModulePlan } from "./plan.js";

export function emitWasmModule(
  plan: WasmModulePlan,
  indices: ModuleIndices
): Uint8Array<ArrayBuffer> {
  return encodeWasmModule(moduleDescription(plan, indices));
}

function moduleDescription(plan: WasmModulePlan, indices: ModuleIndices): WasmModuleDescription {
  const bindings = createModuleBindings(indices);

  return {
    functionTypes: indices.functionTypes,
    functionImports: plan.functionImports.map((imported) => ({
      moduleName: imported.moduleName,
      name: imported.name,
      typeIndex: bindings.functionTypeIndex(imported.type)
    })),
    memoryImports: plan.memoryImports.map((memory) => ({
      moduleName: memory.moduleName,
      name: memory.name,
      limits: memory.limits
    })),
    tableImports: [],
    functions: plan.functions.map((fn) => ({
      typeIndex: bindings.functionTypeIndex(fn.type),
      body: emitWasmFunctionBody(fn.plan, bindings)
    })),
    globals: [],
    functionExports: indices.functionExports.map((exported) => ({
      name: exported.name,
      functionIndex: exported.functionIndex
    }))
  };
}
