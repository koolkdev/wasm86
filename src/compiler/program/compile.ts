import { assert } from "#common/assert.js";
import { buildDefinition } from "#build";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import {
  wasmValueType,
  type WasmFunctionType,
  type WasmValueType
} from "#compiler/encoder/types.js";
import { emitFunction } from "#wasm/emit/action.js";
import type {
  FunctionExportRef,
  FunctionRef,
  GlobalRef,
  SignatureRef,
  TableRef
} from "./refs.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import { createModuleBindings } from "./bindings.js";
import type {
  LegacyFunctionBodyContext
} from "./legacy-body.js";
import type { FunctionType } from "./function-type.js";
import type { FunctionDefinition } from "./functions.js";
import type { Program, ProgramFunction } from "./model.js";
import type { MemoryImport } from "./resources.js";
import { validateProgramEncoding } from "./validate.js";

type LegacyFunction = Extract<ProgramFunction, { kind: "legacy" }>;
type DefinedFunction = Extract<ProgramFunction, { kind: "function" }>;

export type CompiledFunctionExport = Readonly<{
  ref: FunctionExportRef;
  name: string;
}>;

export type CompiledProgram = Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  memoryImports: readonly MemoryImport[];
  functionExports: readonly CompiledFunctionExport[];
}>;

type ProgramLayout = Readonly<{
  types: readonly WasmFunctionType[];
  signatureIndices: ReadonlyMap<SignatureRef, number>;
  typeIndices: ReadonlyMap<FunctionType, number>;
  functionIndices: ReadonlyMap<FunctionRef, number>;
  memoryIndices: ReadonlyMap<ResourceRef, number>;
  tableIndices: ReadonlyMap<TableRef, number>;
  globalIndices: ReadonlyMap<GlobalRef, number>;
}>;

export function compileProgram(program: Program): CompiledProgram {
  return {
    bytes: encodeProgram(program),
    memoryImports: program.memoryImports,
    functionExports: program.exports.map(({ ref, name }) => ({ ref, name }))
  };
}

function encodeProgram(program: Program): Uint8Array<ArrayBuffer> {
  const layout = layoutProgram(program);
  const bodies = program.functions.map((fn) => buildFunctionBody(program, layout, fn));

  if (buildDefinition.validation) {
    validateProgramEncoding(program, bodies, layout);
  }
  const module = new WasmModuleEncoder();

  addFunctionTypes(module, layout);
  addMemoryImports(module, program, layout);
  addTableImports(module, program, layout);
  addGlobals(module, program, layout);
  addFunctions(module, program, layout, bodies);
  addExports(module, program, layout);
  return module.encode();
}

function addFunctionTypes(module: WasmModuleEncoder, layout: ProgramLayout): void {
  for (const [expectedIndex, type] of layout.types.entries()) {
    const index = module.addFunctionType(type);

    assert(index === expectedIndex, `unexpected Wasm function type index: ${index}`);
  }
}

function addMemoryImports(module: WasmModuleEncoder, program: Program, layout: ProgramLayout): void {
  for (const memory of program.memoryImports) {
    const expectedIndex = layout.memoryIndices.get(memory.ref);

    assert(expectedIndex !== undefined, `missing layout for program resource ${memory.ref.id}`);
    const index = module.importMemory(memory.moduleName, memory.name, memory.limits);
    assert(index === expectedIndex, `unexpected Wasm memory index: ${index}`);
  }
}

function addTableImports(module: WasmModuleEncoder, program: Program, layout: ProgramLayout): void {
  for (const table of program.tables) {
    const expectedIndex = layout.tableIndices.get(table.ref);

    assert(expectedIndex !== undefined, `missing layout for program table ${table.ref.id}`);
    const index = module.importTable(table.moduleName, table.name, table.limits);
    assert(index === expectedIndex, `unexpected Wasm table index: ${index}`);
  }
}

function addGlobals(module: WasmModuleEncoder, program: Program, layout: ProgramLayout): void {
  for (const global of program.globals) {
    const expectedIndex = layout.globalIndices.get(global.ref);

    assert(expectedIndex !== undefined, `missing layout for program global ${global.ref.id}`);
    const index = module.addGlobal(global);
    assert(index === expectedIndex, `unexpected Wasm global index: ${index}`);
  }
}

function addFunctions(
  module: WasmModuleEncoder,
  program: Program,
  layout: ProgramLayout,
  bodies: readonly EncodedWasmFunctionBody[]
): void {
  for (const [declarationIndex, fn] of program.functions.entries()) {
    let typeIndex: number | undefined;

    switch (fn.kind) {
      case "legacy":
        typeIndex = layout.signatureIndices.get(fn.signature);
        assert(
          typeIndex !== undefined,
          `missing layout for program signature ${fn.signature.id}`
        );
        break;
      case "function":
        typeIndex = layout.typeIndices.get(fn.type);
        assert(
          typeIndex !== undefined,
          `missing layout for function ${fn.ref.id} type`
        );
        break;
    }
    const expectedIndex = layout.functionIndices.get(fn.ref);
    const body = bodies[declarationIndex];

    assert(expectedIndex !== undefined, `missing layout for program function ${fn.ref.id}`);
    assert(body !== undefined, `missing encoded body for program function ${fn.ref.id}`);
    const index = module.addFunction(typeIndex, body);
    assert(index === expectedIndex, `unexpected Wasm function index: ${index}`);
  }
}

function addExports(module: WasmModuleEncoder, program: Program, layout: ProgramLayout): void {
  for (const exported of program.exports) {
    const functionIndex = layout.functionIndices.get(exported.target);

    assert(functionIndex !== undefined, `missing layout for exported program function ${exported.target.id}`);
    module.exportFunction(exported.name, functionIndex);
  }
}

function layoutProgram(program: Program): ProgramLayout {
  const types: WasmFunctionType[] = [];
  const signatureIndices = new Map<SignatureRef, number>();
  const typeIndices = new Map<FunctionType, number>();

  for (const type of program.functionTypes) {
    const physicalType = encodeFunctionType(type);
    let index = types.findIndex((candidate) => functionTypesEqual(candidate, physicalType));

    if (index === -1) {
      index = types.length;
      types.push(physicalType);
    }
    typeIndices.set(type, index);
  }
  for (const signature of program.signatures) {
    const index = typeIndices.get(signature.type);

    assert(
      index !== undefined,
      `program signature ${signature.ref.id} has no function type index`
    );
    signatureIndices.set(signature.ref, index);
  }

  return {
    types,
    signatureIndices,
    typeIndices,
    functionIndices: new Map(program.functions.map((fn, index) => [fn.ref, index])),
    memoryIndices: new Map(
      program.memoryImports.map((memory, index) => [memory.ref, index])
    ),
    tableIndices: new Map(program.tables.map((table, index) => [table.ref, index])),
    globalIndices: new Map(program.globals.map((global, index) => [global.ref, index]))
  };
}

function buildFunctionBody(
  program: Program,
  layout: ProgramLayout,
  fn: ProgramFunction
): EncodedWasmFunctionBody {
  switch (fn.kind) {
    case "legacy":
      return buildLegacyBody(program, layout, fn);
    case "function":
      return buildDefinedBody(layout, fn);
  }
}

function buildLegacyBody(
  program: Program,
  layout: ProgramLayout,
  fn: LegacyFunction
): EncodedWasmFunctionBody {
  const signatureIndex = layout.signatureIndices.get(fn.signature);

  assert(signatureIndex !== undefined, `missing layout for program signature ${fn.signature.id}`);

  const functions = resolveFunctionIndices(layout, fn);
  const definitions = resolveDefinitionIndices(layout, fn.callTargets);
  const types = resolveTypeIndices(layout, fn.indirectTypes);
  const resources = resolveResourceIndices(layout, fn.resources);

  const globals = new Map<GlobalRef, number>();

  for (const global of fn.globals) {
    const globalIndex = layout.globalIndices.get(global);

    assert(globalIndex !== undefined, `missing layout for program global ${global.id}`);
    globals.set(global, globalIndex);
  }

  const tables = resolveTableIndices(layout, fn.tables);

  const context = {
    bindings: createModuleBindings({
      functionDefinitions: definitions,
      types,
      tables,
      resources
    }),
    functions,
    globals,
    signatureIndex,
    placements: program.placements
  } satisfies LegacyFunctionBodyContext;
  return fn.build(context);
}

function buildDefinedBody(
  layout: ProgramLayout,
  fn: DefinedFunction
): EncodedWasmFunctionBody {
  const definitions = resolveDefinitionIndices(layout, fn.directTargets);
  const types = resolveTypeIndices(layout, fn.indirectTypes);
  const resources = resolveResourceIndices(layout, fn.resources);
  const tables = resolveTableIndices(layout, fn.tables);
  return emitFunction(fn.body, {
    bindings: createModuleBindings({
      functionDefinitions: definitions,
      types,
      tables,
      resources
    }),
    placement: fn.placement
  });
}

function resolveTypeIndices(
  layout: ProgramLayout,
  types: readonly FunctionType[]
): ReadonlyMap<FunctionType, number> {
  const indices = new Map<FunctionType, number>();

  for (const type of types) {
    const typeIndex = layout.typeIndices.get(type);

    assert(typeIndex !== undefined, "missing layout for indirect call type");
    indices.set(type, typeIndex);
  }
  return indices;
}

function resolveTableIndices(
  layout: ProgramLayout,
  refs: readonly TableRef[]
): ReadonlyMap<TableRef, number> {
  const tables = new Map<TableRef, number>();

  for (const table of refs) {
    const tableIndex = layout.tableIndices.get(table);

    assert(tableIndex !== undefined, `missing layout for program table ${table.id}`);
    tables.set(table, tableIndex);
  }
  return tables;
}

function resolveResourceIndices(
  layout: ProgramLayout,
  refs: readonly ResourceRef[]
): ReadonlyMap<ResourceRef, number> {
  const resources = new Map<ResourceRef, number>();

  for (const resource of refs) {
    const memoryIndex = layout.memoryIndices.get(resource);

    assert(memoryIndex !== undefined, `missing layout for program resource ${resource.id}`);
    resources.set(resource, memoryIndex);
  }
  return resources;
}

function resolveFunctionIndices(
  layout: ProgramLayout,
  fn: LegacyFunction
): ReadonlyMap<FunctionRef, number> {
  const functions = new Map<FunctionRef, number>();

  for (const call of fn.calls) {
    const functionIndex = layout.functionIndices.get(call);

    assert(functionIndex !== undefined, `missing layout for called program function ${call.id}`);
    functions.set(call, functionIndex);
  }
  return functions;
}

function resolveDefinitionIndices(
  layout: ProgramLayout,
  calls: readonly FunctionDefinition[]
): ReadonlyMap<FunctionDefinition, number> {
  const functions = new Map<FunctionDefinition, number>();

  for (const call of calls) {
    const functionIndex = layout.functionIndices.get(call.ref);

    assert(functionIndex !== undefined, `missing layout for called program function ${call.ref.id}`);
    functions.set(call, functionIndex);
  }
  return functions;
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

function functionTypesEqual(a: WasmFunctionType, b: WasmFunctionType): boolean {
  return valueTypesEqual(a.params, b.params) && valueTypesEqual(a.results, b.results);
}

function valueTypesEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
