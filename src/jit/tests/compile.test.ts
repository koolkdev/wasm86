import {
  deepStrictEqual,
  notDeepStrictEqual,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { encodeVariant } from "#compiler/layout/variant-codec.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import { functionRef } from "#compiler/ir/refs.js";
import {
  compileJitArtifact,
  compileJitFromMemory,
  type CompiledJitArtifact
} from "#jit/compile.js";
import { snapshotInstructionBytes } from "#jit/instruction-snapshot.js";
import { jitSnapshotRequestByteLength } from "#jit/policy.js";
import {
  PageFaultErrorCode,
  generalProtection,
  invalidOpcode,
  pageFault
} from "#core/exceptions.js";
import { decodeExit, exitLayout } from "#cpu/exit.js";
import { instructionLimitExit } from "#interpreter/exits.js";
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
import { createTestWasmMemories } from "#test/support/wasm-memories.js";

const startEip = 0x1000;
const encodedInstructionLimit = encodeVariant(
  exitLayout,
  instructionLimitExit()
);

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
  const instance = instantiateCompiledProgram(beforeMutation.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
    ]),
    functions: new Map()
  });
  const entry = instance.functionExports.get(beforeMutation.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip });
  ok(typeof entry === "function", "missing exact JIT entry export");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", "JIT entry did not return an encoded exit");
  deepStrictEqual(decodeExit(encodedExit), { kind: "hostTrap", vector: 3 });
});

test("a symbolic JIT artifact is deterministic, detached, and preserves exact refs", () => {
  const memory = memoryWithBytes(
    startEip,
    // mov eax, [0]; final fallthrough dispatches after one instruction.
    [0x8b, 0x05, 0x00, 0x00, 0x00, 0x00]
  );
  const policy = { instructionLimit: 1 } as const;
  const snapshot = snapshotInstructionBytes(
    testExecutionModel.guestMemory.createReader(memory),
    {
      linearStart: startEip,
      byteLength: jitSnapshotRequestByteLength(policy)
    }
  );
  const first = compileJitArtifact({
    snapshot,
    policy,
    model: testExecutionModel
  });
  const repeated = compileJitArtifact({
    snapshot,
    policy,
    model: testExecutionModel
  });

  deepStrictEqual(first.program.bytes, repeated.program.bytes);
  deepStrictEqual(
    first.program.functionImports.map(({ moduleName, name }) => ({
      moduleName,
      name
    })),
    repeated.program.functionImports.map(({ moduleName, name }) => ({
      moduleName,
      name
    }))
  );

  for (const artifact of [first, repeated]) {
    deepStrictEqual(
      Object.keys(artifact).sort(),
      ["entry", "entryEip", "program"]
    );
    deepStrictEqual(
      Object.keys(artifact.program).sort(),
      ["bytes", "functionExports", "functionImports", "memoryImports"]
    );
    strictEqual(artifact.entryEip, startEip);
    strictEqual(artifact.program.functionExports.length, 1);
    strictEqual(artifact.program.functionExports[0]?.ref, artifact.entry);

    strictEqual(artifact.program.functionImports.length, 1);
    const dispatch = artifact.program.functionImports[0];

    ok(dispatch !== undefined, "missing reachable JIT dispatch import");
    deepStrictEqual(Object.keys(dispatch).sort(), ["moduleName", "name", "ref"]);
    strictEqual(dispatch.ref.id, "jit.dispatch");
    strictEqual(dispatch.moduleName, programImportModuleName);
    strictEqual(dispatch.name, "dispatch");

    strictEqual(artifact.program.memoryImports.length, 2);
    strictEqual(
      artifact.program.memoryImports[0]?.ref,
      testExecutionModel.cpuState.resource
    );
    strictEqual(
      artifact.program.memoryImports[1]?.ref,
      testExecutionModel.guestMemory.resource
    );
  }

  const artifactValues: readonly unknown[] = [
    ...Object.values(first),
    ...Object.values(first.program)
  ];

  for (const value of artifactValues) {
    strictEqual(typeof value === "function", false);
    if (typeof value === "object" && value !== null) {
      strictEqual(value instanceof WebAssembly.Module, false);
      strictEqual(value instanceof WebAssembly.Instance, false);
      strictEqual(value instanceof WebAssembly.Memory, false);
      strictEqual(value instanceof WebAssembly.Table, false);
    }
  }
});

test("a reachable JIT dispatch import binds only by its exact ref", () => {
  const memories = createTestWasmMemories();

  writeBackingBytes(memories.guestMemory, startEip, [0x90]);
  const artifact = compileFromMemory(
    memories.guestMemory,
    startEip,
    { instructionLimit: 1 }
  );
  const dispatch = artifact.program.functionImports[0];

  ok(dispatch !== undefined, "missing reachable JIT dispatch import");
  strictEqual(artifact.program.functionImports.length, 1);
  strictEqual(dispatch.ref.id, "jit.dispatch");
  strictEqual(dispatch.moduleName, programImportModuleName);
  strictEqual(dispatch.name, "dispatch");

  throws(
    () => instantiateCompiledProgram(artifact.program, {
      memories: new Map([
        [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
        [testExecutionModel.guestMemory.resource, memories.guestMemory]
      ]),
      functions: new Map()
    }),
    /missing function binding for program function jit\.dispatch/
  );
  throws(
    () => instantiateCompiledProgram(artifact.program, {
      memories: new Map([
        [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
        [testExecutionModel.guestMemory.resource, memories.guestMemory]
      ]),
      functions: new Map([[
        functionRef(dispatch.ref.id),
        () => encodedInstructionLimit
      ]])
    }),
    /missing function binding for program function jit\.dispatch/
  );

  const targets: number[] = [];
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
    ]),
    functions: new Map([[
      dispatch.ref,
      (targetEip: number): bigint => {
        targets.push(targetEip);
        return encodedInstructionLimit;
      }
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);
  const stateView = new DataView(memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip });
  ok(typeof entry === "function", "missing exact JIT entry export");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", "JIT entry did not return an encoded exit");
  strictEqual(encodedExit, encodedInstructionLimit);
  deepStrictEqual(decodeExit(encodedExit), { kind: "instructionLimit" });
  deepStrictEqual(targets, [startEip + 1]);
  const state = readWasmCpuStateSnapshot(stateView);

  strictEqual(state.eip, startEip + 1);
  strictEqual(state.instructionCount, 1);
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
  const exception = pageFault(
    guestMemoryMinimumByteLength,
    PageFaultErrorCode.INSTRUCTION_FETCH
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

test("an absent first encoding compiles #UD", () => {
  const memories = createTestWasmMemories();

  writeBackingBytes(memories.guestMemory, startEip, [0x62]);
  const artifact = compileFromMemory(
    memories.guestMemory,
    startEip,
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
