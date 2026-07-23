import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ProgramBuilder } from "#compiler/program/builder.js";
import { compileProgram } from "#compiler/compile.js";
import { functionType } from "#compiler/ir/function.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef } from "#compiler/ir/refs.js";
import {
  PageFaultErrorCode,
  pageFault
} from "#core/exceptions.js";
import { createCpu } from "#cpu/cpu.js";
import type { CompiledInterpreter } from "#interpreter/program.js";
import { createMachine } from "#machine/machine.js";
import { startAddress } from "#test/support/addresses.js";
import { testExecutionModel } from "#test/support/execution-model.js";

test("Cpu propagates an interpreter Wasm trap", () => {
  const cpu = createTestCpu(compileTestInterpreter("trap"));

  throws(
    () => cpu.run({ instructionBudget: 1 }),
    (error: unknown) => error instanceof WebAssembly.RuntimeError
  );
});

test("Cpu propagates an interpreter exit-decoder error", () => {
  const cpu = createTestCpu(compileTestInterpreter("invalidExit"));

  throws(
    () => cpu.run({ instructionBudget: 1 }),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message === "unknown cpu.exit variant tag: 0"
  );
});

test("Cpu exhausts its instruction budget and resumes only on a later explicit run", () => {
  const machine = createMachine({ memoryByteLength: 0x2000 });
  const bytes = new Uint8Array(machine.memory.buffer);

  bytes.set([
    0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
    0xb9, 0x02, 0x00, 0x00, 0x00, // mov ecx, 2
    0xcd, 0x2e                    // int 0x2e
  ], startAddress);
  machine.cpu.state.core.eip = startAddress;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "instructionLimit"
  });
  strictEqual(machine.cpu.state.core.eip, startAddress + 5);
  strictEqual(machine.cpu.state.instructionCount, 1);
  strictEqual(machine.cpu.state.core.readReg32("eax"), 1);
  strictEqual(machine.cpu.state.core.readReg32("ecx"), 0);

  deepStrictEqual(machine.cpu.run({ instructionBudget: 2 }), {
    kind: "hostTrap",
    vector: 0x2e
  });
  strictEqual(machine.cpu.state.core.eip, startAddress + 12);
  strictEqual(machine.cpu.state.instructionCount, 3);
  strictEqual(machine.cpu.state.core.readReg32("ecx"), 2);
});

test("Cpu fetches any in-bounds guest bytes regardless of which range the caller wrote", () => {
  const machine = createMachine({ memoryByteLength: 0x2000 });
  const writtenProgramAddress = 0x1000;
  const unwrittenExecutionAddress = 0x1800;

  new Uint8Array(machine.memory.buffer).set([0xcc], writtenProgramAddress);
  machine.cpu.state.core.eip = unwrittenExecutionAddress;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "instructionLimit"
  });
  strictEqual(machine.cpu.state.core.eip, unwrittenExecutionAddress + 2);
  strictEqual(machine.cpu.state.instructionCount, 1);
});

test("Cpu reports an interpreter CPU exception from its bound state", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });
  const boundary = machine.memory.buffer.byteLength;

  machine.cpu.state.core.eip = boundary;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "cpuException",
    exception: pageFault(boundary, PageFaultErrorCode.INSTRUCTION_FETCH)
  });
  strictEqual(machine.cpu.state.core.eip, boundary);
  strictEqual(machine.cpu.state.instructionCount, 0);
});

test("Cpu preserves the instruction start when fetch is truncated at guest-memory bounds", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });
  const boundary = machine.memory.buffer.byteLength;
  const instructionStart = boundary - 1;

  new Uint8Array(machine.memory.buffer)[instructionStart] = 0xb8;
  machine.cpu.state.core.eip = instructionStart;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "cpuException",
    exception: pageFault(boundary, PageFaultErrorCode.INSTRUCTION_FETCH)
  });
  strictEqual(machine.cpu.state.core.eip, instructionStart);
  strictEqual(machine.cpu.state.instructionCount, 0);
});

test("Cpu accepts a zero instruction budget without entering an instruction", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });

  machine.cpu.state.core.eip = startAddress;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 0 }), {
    kind: "instructionLimit"
  });
  strictEqual(machine.cpu.state.core.eip, startAddress);
  strictEqual(machine.cpu.state.instructionCount, 0);
});

test("Cpu rejects budgets outside the supported modular deadline range", () => {
  const cpu = createMachine({ memoryByteLength: 0x1000 }).cpu;

  cpu.state.core.eip = startAddress;

  for (const instructionBudget of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0x8000_0000,
    0xffff_ffff,
    0x1_0000_0000
  ]) {
    throws(
      () => cpu.run({ instructionBudget }),
      /instructionBudget must be an integer in the supported modular deadline range/
    );
  }

  strictEqual(cpu.state.core.eip, startAddress);
  strictEqual(cpu.state.instructionCount, 0);
});

function compileTestInterpreter(
  result: "trap" | "invalidExit"
): CompiledInterpreter {
  const program = new ProgramBuilder(testExecutionModel.resources);
  const run = program.defineFunction({
    ref: functionRef(`test.cpu.${result}`),
    type: functionType([], ["i64"]),
    effects: { reads: [], writes: [] }
  }, (fn) => {
    fn.return([
      result === "trap"
        ? fn.values.unreachable("i64")
        : fn.values.const64(0n)
    ]);
  });
  const entry = functionExportRef(`test.cpu.${result}-export`);

  program.exportFunction({
    ref: entry,
    name: `test.cpu.${result}.entry`,
    target: run.ref
  });
  return {
    program: compileProgram(program.finish()),
    entry
  };
}

function createTestCpu(interpreter: CompiledInterpreter) {
  return createCpu({
    state: testExecutionModel.cpuState,
    sharedMemories: new Map(),
    interpreter
  });
}
