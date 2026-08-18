import { assert } from "#common/assert.js";
import type { ResourceRef } from "#compiler/reference.js";
import { wasmPageByteLength } from "#compiler/program/limits.js";
import type { CompiledProgram } from "#compiler/compile.js";
import type { FunctionRef } from "#compiler/reference.js";
import type { FunctionExportRef } from "#compiler/program/exports.js";

const compiledModules = new WeakMap<CompiledProgram, WebAssembly.Module>();

export type ProgramInstance = Readonly<{
  functionExports: ReadonlyMap<FunctionExportRef, WebAssembly.ExportValue>;
}>;

export type ProgramInstanceBindings = Readonly<{
  memories: ReadonlyMap<ResourceRef, WebAssembly.Memory>;
  functions: ReadonlyMap<FunctionRef, Function>;
}>;

export function instantiateCompiledProgram(
  program: CompiledProgram,
  bindings: ProgramInstanceBindings
): ProgramInstance {
  const importsByModule = new Map<string, Map<string, WebAssembly.ImportValue>>();

  for (const imported of program.memoryImports) {
    const memory = bindings.memories.get(imported.ref);

    assert(memory !== undefined, `missing memory binding for program resource ${imported.ref.id}`);
    assert(
      memory.buffer.byteLength >= imported.limits.minPages * wasmPageByteLength,
      `memory binding for program resource ${imported.ref.id} is smaller than its declared minimum`
    );

    addImport(importsByModule, imported.moduleName, imported.name, memory);
  }

  for (const imported of program.functionImports) {
    const fn = bindings.functions.get(imported.ref);

    assert(fn !== undefined, `missing function binding for program function ${imported.ref.id}`);
    addImport(importsByModule, imported.moduleName, imported.name, fn);
  }

  const imports: WebAssembly.Imports = Object.fromEntries(
    [...importsByModule].map(([moduleName, moduleImports]) => [
      moduleName,
      Object.fromEntries(moduleImports)
    ])
  );
  let module = compiledModules.get(program);

  if (module === undefined) {
    module = new WebAssembly.Module(program.bytes);
    compiledModules.set(program, module);
  }
  const instance = new WebAssembly.Instance(module, imports);
  const functionExports = new Map<FunctionExportRef, WebAssembly.ExportValue>();

  for (const exported of program.functionExports) {
    const value = instance.exports[exported.name];

    assert(value !== undefined, `missing function export for program ref ${exported.ref.id}`);
    functionExports.set(exported.ref, value);
  }

  return { functionExports };
}

function addImport(
  importsByModule: Map<string, Map<string, WebAssembly.ImportValue>>,
  moduleName: string,
  name: string,
  value: WebAssembly.ImportValue
): void {
  let moduleImports = importsByModule.get(moduleName);

  if (moduleImports === undefined) {
    moduleImports = new Map();
    importsByModule.set(moduleName, moduleImports);
  }
  moduleImports.set(name, value);
}
