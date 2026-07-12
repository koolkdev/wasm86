import { assert } from "#common/assert.js";
import {
  type EncodedWasmFunctionBody,
  type WasmFunctionReferences
} from "#compiler/encoder/function-body.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import type { WasmFunctionType } from "#compiler/encoder/types.js";
import type {
  FunctionRef,
  GlobalRef,
  ResourceRef,
  SignatureRef,
  TableRef
} from "./refs.js";
import type {
  LegacyFunctionBindings
} from "./legacy-body.js";
import type { Program } from "./builder.js";

type LegacyFunction = Program["functions"][number];

type ProgramLayout = Readonly<{
  types: readonly WasmFunctionType[];
  signatureIndices: ReadonlyMap<SignatureRef, number>;
  functionIndices: ReadonlyMap<FunctionRef, number>;
  memoryIndices: ReadonlyMap<ResourceRef, number>;
  tableIndices: ReadonlyMap<TableRef, number>;
}>;

export function encodeProgram(program: Program): Uint8Array<ArrayBuffer> {
  const layout = layoutProgram(program);
  const bodies = program.functions.map((fn) => buildLegacyBody(layout, fn));
  const module = new WasmModuleEncoder();

  addFunctionTypes(module, layout);
  addMemoryImports(module, program, layout);
  addTableImports(module, program, layout);
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
  for (const memory of program.memories) {
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

function addFunctions(
  module: WasmModuleEncoder,
  program: Program,
  layout: ProgramLayout,
  bodies: readonly EncodedWasmFunctionBody[]
): void {
  for (const [declarationIndex, fn] of program.functions.entries()) {
    const typeIndex = layout.signatureIndices.get(fn.signature);
    const expectedIndex = layout.functionIndices.get(fn.ref);
    const body = bodies[declarationIndex];

    assert(typeIndex !== undefined, `missing layout for program signature ${fn.signature.id}`);
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

  for (const signature of program.signatures) {
    let index = types.findIndex((candidate) => functionTypesEqual(candidate, signature.type));

    if (index === -1) {
      index = types.length;
      types.push(signature.type);
    }
    signatureIndices.set(signature.ref, index);
  }

  return {
    types,
    signatureIndices,
    functionIndices: new Map(program.functions.map((fn, index) => [fn.ref, index])),
    memoryIndices: new Map(program.memories.map((memory, index) => [memory.ref, index])),
    tableIndices: new Map(program.tables.map((table, index) => [table.ref, index]))
  };
}

function buildLegacyBody(
  layout: ProgramLayout,
  fn: LegacyFunction
): EncodedWasmFunctionBody {
  const signatureIndex = layout.signatureIndices.get(fn.signature);

  assert(signatureIndex !== undefined, `missing layout for program signature ${fn.signature.id}`);

  const functions = new Map<FunctionRef, number>();

  for (const call of fn.calls) {
    const functionIndex = layout.functionIndices.get(call);

    assert(functionIndex !== undefined, `missing layout for called program function ${call.id}`);
    functions.set(call, functionIndex);
  }

  const resources = new Map<ResourceRef, number>();

  for (const resource of fn.resources) {
    const memoryIndex = layout.memoryIndices.get(resource);

    assert(memoryIndex !== undefined, `missing layout for program resource ${resource.id}`);
    resources.set(resource, memoryIndex);
  }

  const tables = new Map<TableRef, number>();

  for (const table of fn.tables) {
    const tableIndex = layout.tableIndices.get(table);

    assert(tableIndex !== undefined, `missing layout for program table ${table.id}`);
    tables.set(table, tableIndex);
  }

  const bindings = {
    typeIndex: signatureIndex,
    functions,
    resources,
    globals: new Map<GlobalRef, number>(),
    tables
  } satisfies LegacyFunctionBindings;
  const body = fn.build(bindings);

  validateRecordedReferences(fn, body.references, bindings);
  return body;
}

function validateRecordedReferences(
  fn: LegacyFunction,
  references: WasmFunctionReferences,
  bindings: LegacyFunctionBindings
): void {
  validateRecordedIndices(fn, "function", references.functionIndices, bindings.functions.values());
  validateRecordedIndices(fn, "type", references.typeIndices, [bindings.typeIndex]);
  validateRecordedIndices(fn, "global", references.globalIndices, bindings.globals.values());
  validateRecordedIndices(fn, "table", references.tableIndices, bindings.tables.values());
  validateRecordedIndices(fn, "memory", references.memoryIndices, bindings.resources.values());
}

function validateRecordedIndices(
  fn: LegacyFunction,
  kind: "function" | "type" | "global" | "table" | "memory",
  recorded: readonly number[],
  declared: Iterable<number>
): void {
  const declaredIndices = new Set(declared);

  for (const index of recorded) {
    assert(
      declaredIndices.has(index),
      `legacy function ${fn.ref.id} used undeclared Wasm ${kind} index ${index}`
    );
  }
}

function functionTypesEqual(a: WasmFunctionType, b: WasmFunctionType): boolean {
  return valueTypesEqual(a.params, b.params) && valueTypesEqual(a.results, b.results);
}

function valueTypesEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
