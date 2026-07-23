import {
  deepStrictEqual,
  ok,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import {
  compileJitArtifact,
  compileJitFromMemory,
  type CompiledJitArtifact
} from "#jit/compile.js";
import { snapshotInstructionBytes } from "#jit/instruction-snapshot.js";
import { jitSnapshotRequestByteLength } from "#jit/policy.js";
import { decodeExit } from "#cpu/exit.js";
import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import { writeBackingBytes } from "#memory/bytes.js";
import {
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";

const startEip = 0x1000;

test("compiling a captured snapshot ignores later guest mutation", () => {
  const memories = createTestWasmMemories();
  const policy = { instructionLimit: 2 } as const;

  writeBackingBytes(memories.guestMemory, startEip, [0xcc]);
  const snapshot = snapshotInstructionBytes(
    testExecutionModel.guestMemory.createReader(memories.guestMemory),
    {
      linearStart: startEip,
      byteLength: jitSnapshotRequestByteLength(policy)
    }
  );

  writeBackingBytes(memories.guestMemory, startEip, [0xcd, 0x2e]);
  const artifact = compileJitArtifact({
    snapshot,
    policy,
    model: testExecutionModel
  });

  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
    ]),
    functions: new Map()
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip });
  ok(typeof entry === "function", "missing exact JIT entry export");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", "JIT entry did not return an encoded exit");
  deepStrictEqual(decodeExit(encodedExit), { kind: "hostTrap", vector: 3 });
});

test("an inaccessible block start compiles its exact Memory exception", () => {
  const memories = createTestWasmMemories();
  const start = guestMemoryMinimumByteLength;
  const artifact = compileFromMemory(
    memories.guestMemory,
    start,
    { instructionLimit: 1 }
  );
  const exception = { kind: "PF", linearAddress: start, errorCode: 16 };

  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
    ]),
    functions: new Map()
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, {
    eip: start,
    eax: 7,
    instructionCount: 9
  });
  ok(typeof entry === "function", "missing exact JIT entry export");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", "JIT entry did not return an encoded exit");
  deepStrictEqual(decodeExit(encodedExit), { kind: "cpuException", exception });
  const state = readWasmCpuStateSnapshot(stateView);

  strictEqual(state.eip, start);
  strictEqual(state.eax, 7);
  strictEqual(state.instructionCount, 9);
});

test("a boundary after a completed instruction becomes terminal control", () => {
  const memories = createTestWasmMemories();
  const start = guestMemoryMinimumByteLength - 1;

  writeBackingBytes(memories.guestMemory, start, [0x90]);
  const artifact = compileFromMemory(
    memories.guestMemory,
    start,
    { instructionLimit: 2 }
  );
  const exception = {
    kind: "PF",
    linearAddress: guestMemoryMinimumByteLength,
    errorCode: 16
  };

  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
    ]),
    functions: new Map()
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: start, eax: 4 });
  ok(typeof entry === "function", "missing exact JIT entry export");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", "JIT entry did not return an encoded exit");
  deepStrictEqual(decodeExit(encodedExit), { kind: "cpuException", exception });
  const state = readWasmCpuStateSnapshot(stateView);

  strictEqual(state.eip, guestMemoryMinimumByteLength);
  strictEqual(state.eax, 4);
  strictEqual(state.instructionCount, 1);
});

test("a terminal one-byte instruction at the final backing byte does not consume the boundary", () => {
  const memories = createTestWasmMemories();
  const start = guestMemoryMinimumByteLength - 1;

  writeBackingBytes(memories.guestMemory, start, [0xcc]);
  const artifact = compileFromMemory(
    memories.guestMemory,
    start,
    { instructionLimit: 2 }
  );

  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
    ]),
    functions: new Map()
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: start });
  ok(typeof entry === "function", "missing exact JIT entry export");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", "JIT entry did not return an encoded exit");
  deepStrictEqual(decodeExit(encodedExit), { kind: "hostTrap", vector: 3 });
  const state = readWasmCpuStateSnapshot(stateView);

  strictEqual(state.eip, guestMemoryMinimumByteLength);
  strictEqual(state.instructionCount, 1);
});

test("fifteen admitted prefix bytes compile GP without reading a forbidden boundary", () => {
  const memories = createTestWasmMemories();
  const bytes = new Array<number>(15).fill(0x66);
  const start = guestMemoryMinimumByteLength - bytes.length;

  writeBackingBytes(memories.guestMemory, start, bytes);
  const artifact = compileFromMemory(
    memories.guestMemory,
    start,
    { instructionLimit: 1 }
  );

  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
    ]),
    functions: new Map()
  });
  const entry = instance.functionExports.get(artifact.entry);

  ok(typeof entry === "function", "missing exact JIT entry export");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", "JIT entry did not return an encoded exit");
  deepStrictEqual(decodeExit(encodedExit), {
    kind: "cpuException",
    exception: { kind: "GP", errorCode: 0 }
  });
});

test("an unavailable earlier permitted byte compiles the boundary fault instead of GP", () => {
  const memories = createTestWasmMemories();
  const bytes = new Array<number>(14).fill(0x66);
  const start = guestMemoryMinimumByteLength - bytes.length;

  writeBackingBytes(memories.guestMemory, start, bytes);
  const artifact = compileFromMemory(
    memories.guestMemory,
    start,
    { instructionLimit: 1 }
  );
  const exception = {
    kind: "PF",
    linearAddress: guestMemoryMinimumByteLength,
    errorCode: 16
  };

  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
    ]),
    functions: new Map()
  });
  const entry = instance.functionExports.get(artifact.entry);

  ok(typeof entry === "function", "missing exact JIT entry export");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", "JIT entry did not return an encoded exit");
  deepStrictEqual(decodeExit(encodedExit), { kind: "cpuException", exception });
});

function compileFromMemory(
  memory: WebAssembly.Memory,
  start: number,
  policy: Readonly<{ instructionLimit: number }>
): CompiledJitArtifact {
  return compileJitFromMemory({
    memory,
    start,
    policy,
    model: testExecutionModel
  });
}
