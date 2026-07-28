import { assert } from "#common/assert.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import { encodeWasmModule, type WasmModuleDescription } from "#compiler/encoder/module.js";
import {
  wasmValueType,
  type WasmFunctionType,
  type WasmValueType
} from "#compiler/encoder/types.js";
import type { FunctionType } from "#compiler/ir/function.js";
import { createModuleBindings } from "#compiler/module/bindings.js";
import type { ModuleLayout } from "#compiler/module/layout.js";
import type { Program, ProgramFunction } from "#compiler/program/program.js";
import { emitFunction } from "./function.js";

// Realizes a completed symbolic Program into an already-indexed description,
// then delegates byte serialization to the encoder.
export function emitModule(program: Program, layout: ModuleLayout): Uint8Array<ArrayBuffer> {
  return encodeWasmModule(moduleDescription(program, layout));
}

function moduleDescription(program: Program, layout: ModuleLayout): WasmModuleDescription {
  return {
    functionTypes: layout.types.map(encodeFunctionType),
    functionImports: program.functionImports.map((imported) => ({
      moduleName: imported.moduleName,
      name: imported.name,
      typeIndex: requireTypeIndex(layout, imported.type)
    })),
    memoryImports: program.memoryImports.map((memory) => ({
      moduleName: memory.moduleName,
      name: memory.name,
      limits: memory.limits
    })),
    tableImports: program.tables.map((table) => ({
      moduleName: table.moduleName,
      name: table.name,
      limits: table.limits
    })),
    functions: program.functions.map((fn) => ({
      typeIndex: requireTypeIndex(layout, fn.type),
      body: emitProgramFunction(layout, fn)
    })),
    globals: [],
    functionExports: layout.functionExports.map((exported) => ({
      name: exported.name,
      functionIndex: exported.functionIndex
    }))
  };
}

function emitProgramFunction(layout: ModuleLayout, fn: ProgramFunction): EncodedWasmFunctionBody {
  return emitFunction(fn.body, {
    bindings: createModuleBindings({
      functions: selectIndices(layout.functionIndices, fn.directFunctions, "called function"),
      types: selectIndices(layout.typeIndices, fn.indirectTypes, "indirect call type"),
      tables: selectIndices(layout.tableIndices, fn.tables, "referenced table"),
      resources: selectIndices(layout.memoryIndices, fn.resources, "referenced resource")
    }),
    placement: fn.placement
  });
}

function encodeFunctionType(type: FunctionType): WasmFunctionType {
  return {
    params: type.parameters.map(encodeValueType),
    results: type.results.map(encodeValueType)
  };
}

function encodeValueType(type: FunctionType["parameters"][number]): WasmValueType {
  switch (type) {
    case "i32":
      return wasmValueType.i32;
    case "i64":
      return wasmValueType.i64;
  }
}

function requireTypeIndex(layout: ModuleLayout, type: FunctionType): number {
  return requireIndex(layout.typeIndices, type, "function type");
}

function requireIndex<Key>(indices: ReadonlyMap<Key, number>, key: Key, label: string): number {
  const index = indices.get(key);

  assert(index !== undefined, `missing module layout for ${label}`);
  return index;
}

function selectIndices<Key>(
  indices: ReadonlyMap<Key, number>,
  keys: readonly Key[],
  label: string
): ReadonlyMap<Key, number> {
  return new Map(keys.map((key) => [key, requireIndex(indices, key, label)]));
}
