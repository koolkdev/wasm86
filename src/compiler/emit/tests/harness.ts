import { assert } from "#common/assert.js";
import type { StorageAccess, StorageEffects } from "#compiler/ir/effects.js";
import type { CompiledProgram } from "#compiler/compile.js";
import { compileProgram } from "#compiler/compile.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/ir/function.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef } from "#compiler/ir/refs.js";
import type { FunctionBuilder } from "#compiler/ir/builder/function.js";
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
