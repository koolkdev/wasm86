import {
  deepStrictEqual,
  ok,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import {
  compileJitFromReader,
  type CompiledJitArtifact
} from "#jit/compile.js";
import { decodeExit } from "#cpu/exit.js";
import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import { writeBackingBytes } from "#memory/bytes.js";
import {
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  testExecutionModel
} from "#test/support/execution-model.js";
import {
  createTestWasmMemories,
  type TestWasmMemories
} from "#test/support/wasm-memories.js";

const startEip = 0x1000;
const instructionLimitExit = 0x0007_0000_0000_0000n;

test("a completed block commits its final state before fallthrough dispatch", () => {
  const memories = createTestWasmMemories();
  const artifact = compileFromMemory(
    memories,
    startEip,
    { instructionLimit: 2 },
    [
      0x83, 0xc0, 0x01, // add eax, 1
      0x83, 0xc0, 0x01  // add eax, 1
    ]
  );
  const imported = artifact.program.functionImports[0];
  const dispatchTargets: number[] = [];
  const stateView = new DataView(memories.cpuStateMemory.buffer);

  ok(imported !== undefined, "fallthrough block has no dispatch import");
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memories.programMemories,
    functions: new Map([[
      imported.ref,
      (targetEip: number): bigint => {
        dispatchTargets.push(targetEip >>> 0);
        return instructionLimitExit;
      }
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, eax: 7 });
  ok(typeof entry === "function", "compiled JIT entry export is not callable");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", "JIT entry did not return an encoded exit");
  deepStrictEqual(decodeExit(encodedExit), { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets, [startEip + 6]);
  const state = readWasmCpuStateSnapshot(stateView);

  strictEqual(state.eax, 9);
  strictEqual(state.eip, startEip + 6);
  strictEqual(state.instructionCount, 2);
});

test("a mid-block data fault reports the faulting eip after committing earlier state", () => {
  const faultAddress = 0xff_0000;
  const memories = createTestWasmMemories();
  const artifact = compileFromMemory(
    memories,
    startEip,
    { instructionLimit: 2 },
    [
      0x40,                               // inc eax
      0x8b, 0x05, 0x00, 0x00, 0xff, 0x00 // mov eax, [0xff0000]
    ]
  );
  const imported = artifact.program.functionImports[0];
  const dispatchTargets: number[] = [];
  const stateView = new DataView(memories.cpuStateMemory.buffer);

  ok(imported !== undefined, "fallthrough block has no dispatch import");
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memories.programMemories,
    functions: new Map([[
      imported.ref,
      (targetEip: number): bigint => {
        dispatchTargets.push(targetEip >>> 0);
        return instructionLimitExit;
      }
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, eax: 5 });
  ok(typeof entry === "function", "compiled JIT entry export is not callable");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", "JIT entry did not return an encoded exit");
  deepStrictEqual(decodeExit(encodedExit), {
    kind: "cpuException",
    exception: { kind: "PF", linearAddress: faultAddress, errorCode: 0 }
  });
  const state = readWasmCpuStateSnapshot(stateView);

  strictEqual(state.eax, 6);
  strictEqual(state.eip, startEip + 1);
  strictEqual(state.instructionCount, 1);
  deepStrictEqual(dispatchTargets, []);
});

test("an inaccessible block start compiles its exact Memory exception", () => {
  const memories = createTestWasmMemories();
  const start = guestMemoryMinimumByteLength;
  const artifact = compileFromMemory(
    memories,
    start,
    { instructionLimit: 1 }
  );
  const exception = { kind: "PF", linearAddress: start, errorCode: 16 };

  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memories.programMemories,
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
    memories,
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
    memories: memories.programMemories,
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
    memories,
    start,
    { instructionLimit: 2 }
  );

  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memories.programMemories,
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

function compileFromMemory(
  memories: TestWasmMemories,
  start: number,
  policy: Readonly<{ instructionLimit: number }>,
  bytes?: readonly number[]
): CompiledJitArtifact {
  if (bytes !== undefined) {
    const firstFailingAddress = writeBackingBytes(
      memories.guestMemory,
      start,
      bytes
    );

    ok(
      firstFailingAddress === undefined,
      `JIT source bytes exceed guest memory at 0x${firstFailingAddress?.toString(16)}`
    );
  }
  return compileJitFromReader({
    reader: memories.reader,
    start,
    policy,
    model: testExecutionModel
  });
}
