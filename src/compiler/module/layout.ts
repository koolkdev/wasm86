import { assert } from "#common/assert.js";
import type { FunctionType } from "#compiler/ir/function.js";
import type { FunctionRef, TableRef } from "#compiler/ir/refs.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { FunctionExportRef } from "#compiler/program/exports.js";
import type { Program } from "#compiler/program/program.js";

// The sole authority for symbolic-to-numeric module identities. The encoder
// serializes this already-decided ordering; it does not independently lay out
// program declarations.
export type ModuleFunctionExport = Readonly<{
  ref: FunctionExportRef;
  name: string;
  functionIndex: number;
}>;

export type ModuleLayout = Readonly<{
  types: readonly FunctionType[];
  typeIndices: ReadonlyMap<FunctionType, number>;
  functionIndices: ReadonlyMap<FunctionRef, number>;
  memoryIndices: ReadonlyMap<ResourceRef, number>;
  tableIndices: ReadonlyMap<TableRef, number>;
  functionExports: readonly ModuleFunctionExport[];
}>;

export function layoutProgram(program: Program): ModuleLayout {
  const types: FunctionType[] = [];
  const typeIndices = new Map<FunctionType, number>();

  for (const type of program.functionTypes) {
    let index = types.findIndex((candidate) => functionTypesEqual(candidate, type));

    if (index === -1) {
      index = types.length;
      types.push(type);
    }
    typeIndices.set(type, index);
  }

  const functionIndices = new Map([
    ...program.functionImports.map((fn, index) => [fn.ref, index] as const),
    ...program.functions.map(
      (fn, index) => [fn.ref, program.functionImports.length + index] as const
    )
  ]);
  const functionExports = program.exports.map((exported): ModuleFunctionExport => {
    const functionIndex = functionIndices.get(exported.target);

    assert(
      functionIndex !== undefined,
      `missing layout for exported program function ${exported.target.id}`
    );
    return {
      ref: exported.ref,
      name: exported.name,
      functionIndex
    };
  });

  return {
    types,
    typeIndices,
    functionIndices,
    memoryIndices: new Map(program.memoryImports.map((memory, index) => [memory.ref, index])),
    tableIndices: new Map(program.tables.map((table, index) => [table.ref, index])),
    functionExports
  };
}

function functionTypesEqual(a: FunctionType, b: FunctionType): boolean {
  return valueTypesEqual(a.parameters, b.parameters) && valueTypesEqual(a.results, b.results);
}

function valueTypesEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
