import { emitModule } from "#compiler/emit/module.js";
import type { FunctionRef } from "#compiler/ir/refs.js";
import { layoutProgram } from "#compiler/module/layout.js";
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
  const layout = layoutProgram(program);

  return {
    bytes: emitModule(program, layout),
    memoryImports: program.memoryImports,
    functionImports: program.functionImports.map(({ ref, moduleName, name }) => ({
      ref,
      moduleName,
      name
    })),
    functionExports: program.exports.map(({ ref, name }) => ({ ref, name }))
  };
}
