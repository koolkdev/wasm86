import { emitWasmModule } from "#compiler/wasm/module/emit.js";
import type { FunctionRef } from "#compiler/reference.js";
import { indexWasmModule } from "#compiler/wasm/module/indices.js";
import { planWasmModule } from "#compiler/wasm/module/plan.js";
import type { FunctionExportRef } from "#compiler/program/exports.js";
import type { Program } from "#compiler/program/program.js";
import type { MemoryImport } from "#compiler/program/resources.js";

export type CompiledFunctionExport = Readonly<{
  ref: FunctionExportRef;
  name: string;
}>;

export type CompiledFunctionImport = Readonly<{
  ref: FunctionRef;
  moduleName: string;
  name: string;
}>;

export type CompiledProgram = Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  memoryImports: readonly MemoryImport[];
  functionImports: readonly CompiledFunctionImport[];
  functionExports: readonly CompiledFunctionExport[];
}>;

export function compileProgram(program: Program): CompiledProgram {
  const plan = planWasmModule(program);
  const indices = indexWasmModule(plan);

  return {
    bytes: emitWasmModule(plan, indices),
    memoryImports: plan.memoryImports,
    functionImports: plan.functionImports.map(({ ref, moduleName, name }) => ({
      ref,
      moduleName,
      name
    })),
    functionExports: plan.exports.map(({ ref, name }) => ({ ref, name }))
  };
}
