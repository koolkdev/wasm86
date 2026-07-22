import {
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  compileJitArtifact,
  compileJitFromMemory,
  type CompiledJitArtifact
} from "#engines/jit/compile.js";
import { snapshotInstructionBytes } from "#engines/jit/instruction-snapshot.js";
import { jitSnapshotRequestByteLength } from "#engines/jit/policy.js";
import {
  PageFaultErrorCode,
  generalProtection,
  invalidOpcode,
  pageFault
} from "#core/exceptions.js";
import {
  guestMemoryMinimumByteLength,
  guestMemoryMinimumPages
} from "#memory/constants.js";
import { writeBackingBytes } from "#memory/bytes.js";
import {
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import { instantiateJitArtifact } from "#test/support/jit-artifact.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";

const startEip = 0x1000;

test("JIT compilation is stable over a snapshot after guest mutation", () => {
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
  const beforeMutation = compileJitArtifact({
    snapshot,
    policy,
    model: testExecutionModel
  });
  const repeated = compileJitArtifact({
    snapshot,
    policy,
    model: testExecutionModel
  });
  const afterMutation = compileJitFromMemory({
    memory: memories.guestMemory,
    start: startEip,
    policy,
    model: testExecutionModel
  });

  deepStrictEqual(beforeMutation.program.bytes, repeated.program.bytes);
  notDeepStrictEqual(
    beforeMutation.program.bytes,
    afterMutation.program.bytes
  );

  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const oldHandle = instantiateJitArtifact(testExecutionModel, beforeMutation, {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  writeWasmCpuStateSnapshot(stateView, { eip: startEip });
  deepStrictEqual(oldHandle.run().exit, { kind: "hostTrap", vector: 3 });
});

test("unused snapshot tail does not change artifact bytes", () => {
  const first = memoryWithBytes(startEip, [0xcc, 0x11]);
  const second = memoryWithBytes(startEip, [0xcc, 0xee]);
  const policy = { instructionLimit: 2 } as const;
  const a = compileFromMemory(first, startEip, policy);
  const b = compileFromMemory(second, startEip, policy);

  deepStrictEqual(a.program.bytes, b.program.bytes);
});

test("decode past a semantic terminal does not change artifact bytes", () => {
  const first = memoryWithBytes(startEip, [0x8e, 0xc0, 0x40]);
  const second = memoryWithBytes(startEip, [0x8e, 0xc0, 0x90]);
  const policy = { instructionLimit: 2 } as const;
  const a = compileFromMemory(first, startEip, policy);
  const b = compileFromMemory(second, startEip, policy);

  deepStrictEqual(a.program.bytes, b.program.bytes);
});

test("an inaccessible block start compiles its exact Memory exception", () => {
  const memories = createTestWasmMemories();
  const start = guestMemoryMinimumByteLength;
  const artifact = compileFromMemory(
    memories.guestMemory,
    start,
    { instructionLimit: 1 }
  );
  const exception = pageFault(start, PageFaultErrorCode.INSTRUCTION_FETCH);

  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const handle = instantiateJitArtifact(testExecutionModel, artifact, {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  writeWasmCpuStateSnapshot(stateView, {
    eip: start,
    eax: 7,
    instructionCount: 9
  });
  deepStrictEqual(handle.run().exit, { kind: "cpuException", exception });
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
  const exception = pageFault(
    guestMemoryMinimumByteLength,
    PageFaultErrorCode.INSTRUCTION_FETCH
  );

  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const handle = instantiateJitArtifact(testExecutionModel, artifact, {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  writeWasmCpuStateSnapshot(stateView, { eip: start, eax: 4 });
  deepStrictEqual(handle.run().exit, { kind: "cpuException", exception });
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
  const handle = instantiateJitArtifact(testExecutionModel, artifact, {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  writeWasmCpuStateSnapshot(stateView, { eip: start });
  deepStrictEqual(handle.run().exit, { kind: "hostTrap", vector: 3 });
  const state = readWasmCpuStateSnapshot(stateView);

  strictEqual(state.eip, guestMemoryMinimumByteLength);
  strictEqual(state.instructionCount, 1);
});

test("an absent first encoding compiles #UD", () => {
  const memories = createTestWasmMemories();

  writeBackingBytes(memories.guestMemory, startEip, [0x62]);
  const artifact = compileFromMemory(
    memories.guestMemory,
    startEip,
    { instructionLimit: 1 }
  );

  const handle = instantiateJitArtifact(testExecutionModel, artifact, {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  deepStrictEqual(handle.run().exit, {
    kind: "cpuException",
    exception: invalidOpcode()
  });
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

  const handle = instantiateJitArtifact(testExecutionModel, artifact, {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  deepStrictEqual(handle.run().exit, {
    kind: "cpuException",
    exception: generalProtection(0)
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
  const exception = pageFault(
    guestMemoryMinimumByteLength,
    PageFaultErrorCode.INSTRUCTION_FETCH
  );

  const handle = instantiateJitArtifact(testExecutionModel, artifact, {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  deepStrictEqual(handle.run().exit, { kind: "cpuException", exception });
});

test("JIT snapshot policy derives its byte window", () => {
  strictEqual(
    jitSnapshotRequestByteLength({ instructionLimit: 3 }),
    45
  );
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

function memoryWithBytes(
  start: number,
  bytes: readonly number[]
): WebAssembly.Memory {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });

  writeBackingBytes(memory, start, bytes);
  return memory;
}
