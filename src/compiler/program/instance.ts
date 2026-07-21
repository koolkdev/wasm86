import { assert } from "#common/assert.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import { wasmPageByteLength } from "./pages.js";
import type { CompiledProgram } from "./compile.js";
import type { FunctionExportRef } from "./refs.js";

const compiledModules = new WeakMap<CompiledProgram, WebAssembly.Module>();

export type ProgramInstance = Readonly<{
  functionExports: ReadonlyMap<FunctionExportRef, WebAssembly.ExportValue>;
}>;

export function instantiateCompiledProgram(
  program: CompiledProgram,
  memories: ReadonlyMap<ResourceRef, WebAssembly.Memory>
): ProgramInstance {
  const importsByModule = new Map<string, Map<string, WebAssembly.Memory>>();

  for (const imported of program.memoryImports) {
    const memory = memories.get(imported.ref);

    assert(
      memory !== undefined,
      `missing memory binding for program resource ${imported.ref.id}`
    );
    assert(
      memory.buffer.byteLength >= imported.limits.minPages * wasmPageByteLength,
      `memory binding for program resource ${imported.ref.id} is smaller than its declared minimum`
    );

    let moduleImports = importsByModule.get(imported.moduleName);

    if (moduleImports === undefined) {
      moduleImports = new Map();
      importsByModule.set(imported.moduleName, moduleImports);
    }
    moduleImports.set(imported.name, memory);
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

    assert(
      value !== undefined,
      `missing function export for program ref ${exported.ref.id}`
    );
    functionExports.set(exported.ref, value);
  }

  return { functionExports };
}
