import { assert } from "#common/assert.js";
import type { StorageAccess, StorageEffects } from "#compiler/ir/effects.js";
import type { CompiledProgram } from "#compiler/program/compile.js";
import { compileProgram } from "#compiler/program/compile.js";
import { instantiateCompiledProgram } from "#compiler/program/instance.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/program/function-type.js";
import {
  functionExportRef,
  functionRef
} from "#compiler/program/refs.js";
import type { FunctionBuilder } from "#ir/function.js";
import { wasmSectionId } from "#compiler/encoder/types.js";
import {
  cpuState,
  guestMemoryResource,
  testExecutionModel
} from "#test/support/execution-model.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";

const testFunctionExport = functionExportRef("test.wasm-function.entry-export");
const testFunctionExportName = "run";

export const testFunctionCompleted = -1n;
export const testModuleMemoryIndex = {
  cpuState: 0,
  guest: 1
} as const;

export type TestFunction = Readonly<{
  parameterCount: number;
  build(fn: FunctionBuilder): void;
}>;

export type InstantiatedTestFunction = Readonly<{
  stateMemory: WebAssembly.Memory;
  stateView: DataView;
  guestView: DataView;
  run(...parameters: number[]): bigint;
}>;

export function testFunction(
  parameterCount: number,
  build: (fn: FunctionBuilder) => void
): TestFunction {
  assert(
    Number.isInteger(parameterCount) && parameterCount >= 0,
    `invalid test function parameter count: ${parameterCount}`
  );
  return { parameterCount, build };
}

export function completedTestFunction(
  parameterCount: number,
  build: (fn: FunctionBuilder) => void
): TestFunction {
  return testFunction(parameterCount, (fn) => {
    build(fn);
    returnTestFunctionCompleted(fn);
  });
}

export function returnTestFunctionCompleted(fn: FunctionBuilder): void {
  fn.return([fn.values.const64(testFunctionCompleted)]);
}

export function compileTestFunction(fixture: TestFunction): CompiledProgram {
  return compileProgram(buildTestProgram(fixture));
}

export function testFunctionBody(fixture: TestFunction): Uint8Array<ArrayBuffer> {
  return firstWasmFunctionBody(compileTestFunction(fixture).bytes);
}

export function testFunctionBranchHints(fixture: TestFunction): readonly number[] {
  const compiled = compileTestFunction(fixture);
  const module = new WebAssembly.Module(compiled.bytes);
  const sections = WebAssembly.Module.customSections(
    module,
    "metadata.code.branch_hint"
  );

  if (sections.length === 0) {
    return [];
  }
  assert(sections.length === 1, "test function has duplicate branch-hint sections");
  const section = new Uint8Array(sections[0]!);
  let cursor = readU32(section, 0);
  const functionCount = cursor.value;
  const values: number[] = [];

  for (let functionEntry = 0; functionEntry < functionCount; functionEntry += 1) {
    const functionIndex = readU32(section, cursor.nextOffset);
    const hintCount = readU32(section, functionIndex.nextOffset);

    cursor = hintCount;
    for (let hintIndex = 0; hintIndex < hintCount.value; hintIndex += 1) {
      const offset = readU32(section, cursor.nextOffset);
      const metadataCount = readU32(section, offset.nextOffset);

      assert(metadataCount.value === 1, "unexpected branch-hint metadata count");
      const value = readU32(section, metadataCount.nextOffset);

      if (functionIndex.value === 0) {
        values.push(value.value);
      }
      cursor = value;
    }
  }
  return values;
}

export async function instantiateTestFunction(
  fixture: TestFunction
): Promise<InstantiatedTestFunction> {
  const memories = createTestWasmMemories();
  const compiled = compileTestFunction(fixture);
  const instance = instantiateCompiledProgram(compiled, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
    ]),
    functions: new Map()
  });
  const run = instance.functionExports.get(testFunctionExport);

  assert(typeof run === "function", `missing Wasm ${testFunctionExportName} export`);

  return {
    stateMemory: memories.cpuStateMemory,
    stateView: new DataView(memories.cpuStateMemory.buffer),
    guestView: new DataView(memories.guestMemory.buffer),
    run: (...parameters) => (run as (...args: number[]) => bigint)(...parameters)
  };
}

function buildTestProgram(fixture: TestFunction) {
  const program = new ProgramBuilder(testExecutionModel.resources);
  const entry = program.defineFunction({
    ref: functionRef("test.wasm-function.entry"),
    type: functionType(
      Array.from({ length: fixture.parameterCount }, () => "i32" as const),
      ["i64"]
    ),
    effects: testFunctionEffects
  }, (fn) => fixture.build(fn));

  program.exportFunction({
    ref: testFunctionExport,
    name: testFunctionExportName,
    target: entry.ref
  });
  return program.finish();
}

const wholeCpuState: StorageAccess = {
  space: "resource",
  resource: cpuState.resource,
  range: { basis: { kind: "resource" } }
};
const wholeGuestMemory: StorageAccess = {
  space: "resource",
  resource: guestMemoryResource,
  range: { basis: { kind: "resource" } }
};
const testFunctionEffects: StorageEffects = {
  reads: [wholeCpuState, wholeGuestMemory],
  writes: [wholeCpuState, wholeGuestMemory]
};

function firstWasmFunctionBody(
  moduleBytes: Uint8Array<ArrayBuffer>
): Uint8Array<ArrayBuffer> {
  let offset = 8;

  while (offset < moduleBytes.length) {
    const sectionId = moduleBytes[offset];

    assert(sectionId !== undefined, "missing Wasm section id");
    const sectionSize = readU32(moduleBytes, offset + 1);
    const sectionStart = sectionSize.nextOffset;
    const sectionEnd = sectionStart + sectionSize.value;

    if (sectionId === wasmSectionId.code) {
      const functionCount = readU32(moduleBytes, sectionStart);

      assert(functionCount.value > 0, "test module has no Wasm function bodies");
      const bodySize = readU32(moduleBytes, functionCount.nextOffset);
      const bodyStart = bodySize.nextOffset;

      return moduleBytes.slice(bodyStart, bodyStart + bodySize.value);
    }
    offset = sectionEnd;
  }
  throw new Error("missing Wasm code section");
}

type U32Read = Readonly<{ value: number; nextOffset: number }>;

function readU32(bytes: Uint8Array, start: number): U32Read {
  let value = 0;
  let shift = 0;
  let offset = start;

  while (offset < bytes.length) {
    const byte = bytes[offset];

    assert(byte !== undefined, "truncated u32 LEB128");
    value |= (byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, nextOffset: offset };
    }
    shift += 7;
    assert(shift < 35, "u32 LEB128 is too wide");
  }
  throw new Error("truncated u32 LEB128");
}
