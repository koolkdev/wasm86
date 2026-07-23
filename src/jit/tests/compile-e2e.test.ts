import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { encodeVariant } from "#compiler/layout/variant-codec.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import type { FunctionRef } from "#compiler/ir/refs.js";
import type { RunStop } from "#cpu/cpu.js";
import { decodeExit, exitLayout } from "#cpu/exit.js";
import {
  compileJitFromMemory,
  type CompiledJitArtifact
} from "#jit/compile.js";
import { instructionLimitExit } from "#interpreter/exits.js";
import {
  readWasmCpuStateSnapshot,
  type WasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";
import { jitMemoryWithBytes } from "./memory-fixture.js";

const startEip = 0x1000;
const encodedDispatchStop = encodeVariant(
  exitLayout,
  instructionLimitExit()
);

test("JIT compiles a decode-time CPU exception after decoded instructions", () => {
  const artifact = compileArtifact([0x40, 0x62], 2);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);

  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memoryBindings(memories),
    functions: new Map()
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, eax: 4 });
  ok(typeof entry === "function", "compiled JIT entry is not callable");
  const exit = decodeEntryResult(entry());
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: { kind: "UD" }
  });
  strictEqual(state.eax, 5);
  strictEqual(state.eip, startEip + 1);
  strictEqual(state.instructionCount, 1);
});

test("an empty decode-time CPU exception commits its instruction start", () => {
  const artifact = compileArtifact([0x62], 1);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);

  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memoryBindings(memories),
    functions: new Map()
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, {
    eip: startEip + 0x123,
    instructionCount: 0
  });
  ok(typeof entry === "function", "compiled JIT entry is not callable");
  const exit = decodeEntryResult(entry());
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: { kind: "UD" }
  });
  strictEqual(state.eip, startEip);
  strictEqual(state.instructionCount, 0);
});

test("a repeated add commits its final state before fallthrough dispatch", () => {
  // add eax, 1; add eax, 1.
  const artifact = compileArtifact(
    [0x83, 0xc0, 0x01, 0x83, 0xc0, 0x01],
    2
  );
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const dispatches: DispatchObservation[] = [];
  const imported = artifact.program.functionImports[0];

  ok(imported !== undefined, "fallthrough block has no dispatch import");
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memoryBindings(memories),
    functions: new Map<FunctionRef, Function>([[
      imported.ref,
      createDispatchRecorder(memories, dispatches)
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, eax: 7 });
  ok(typeof entry === "function", "compiled JIT entry is not callable");
  const exit = decodeEntryResult(entry());

  deepStrictEqual(exit, { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets(dispatches), [startEip + 6]);
  strictEqual(dispatches[0]?.state.eax, 9);
  strictEqual(dispatches[0]?.state.eip, startEip + 6);
  strictEqual(dispatches[0]?.state.instructionCount, 2);
});

test("a guard fault mid-block reports the faulting eip with earlier state flushed", () => {
  // inc eax; mov eax, [0xff0000] — beyond the one-page guest memory.
  const faultAddress = 0xff_0000;
  const artifact = compileArtifact(
    [0x40, 0x8b, 0x05, 0x00, 0x00, 0xff, 0x00],
    2
  );
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);

  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memoryBindings(memories),
    functions: new Map()
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, eax: 5 });
  ok(typeof entry === "function", "compiled JIT entry is not callable");
  const exit = decodeEntryResult(entry());
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: { kind: "PF", linearAddress: faultAddress, errorCode: 0 }
  });
  strictEqual(state.eax, 6);
  strictEqual(state.eip, startEip + 1);
  strictEqual(state.instructionCount, 1);
});


test("a backward side transfer dispatches once", () => {
  // sub ecx, 1; jnz start; int 0x2e.
  const artifact = compileArtifact([
    0x83, 0xe9, 0x01,
    0x75, 0xfb,
    0xcd, 0x2e
  ], 3);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const dispatches: DispatchObservation[] = [];
  const imported = artifact.program.functionImports[0];

  ok(imported !== undefined, "backward jcc has no dispatch import");
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memoryBindings(memories),
    functions: new Map<FunctionRef, Function>([[
      imported.ref,
      createDispatchRecorder(memories, dispatches)
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, ecx: 3 });
  ok(typeof entry === "function", "compiled JIT entry is not callable");
  const exit = decodeEntryResult(entry());

  deepStrictEqual(exit, { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets(dispatches), [startEip]);
});

test("dynamic dispatch preserves the full u32 target", () => {
  const targetEip = 0xf000_4000;
  const artifact = compileArtifact([0xff, 0xe0], 1);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const dispatches: DispatchObservation[] = [];
  const imported = artifact.program.functionImports[0];

  ok(imported !== undefined, "dynamic jump has no dispatch import");
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memoryBindings(memories),
    functions: new Map<FunctionRef, Function>([[
      imported.ref,
      createDispatchRecorder(memories, dispatches)
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, {
    eip: startEip,
    eax: targetEip
  });
  ok(typeof entry === "function", "compiled JIT entry is not callable");
  const exit = decodeEntryResult(entry());

  deepStrictEqual(exit, { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets(dispatches), [targetEip]);
});

type TestMemories = ReturnType<typeof createTestWasmMemories>;

type DispatchObservation = Readonly<{
  targetEip: number;
  state: WasmCpuStateSnapshot;
}>;

function compileArtifact(
  bytes: readonly number[],
  instructionLimit: number,
  eip = startEip
): CompiledJitArtifact {
  return compileJitFromMemory({
    memory: jitMemoryWithBytes(bytes, eip),
    start: eip,
    policy: { instructionLimit },
    model: testExecutionModel
  });
}

function createDispatchRecorder(
  memories: TestMemories,
  dispatches: DispatchObservation[]
): (targetEip: number) => bigint {
  return (targetEip: number): bigint => {
    dispatches.push({
      targetEip: targetEip >>> 0,
      state: readWasmCpuStateSnapshot(
        new DataView(memories.cpuStateMemory.buffer)
      )
    });
    return encodedDispatchStop;
  };
}

function decodeEntryResult(encoded: unknown): RunStop {
  ok(
    typeof encoded === "bigint",
    `compiled JIT entry returned ${typeof encoded}, expected bigint`
  );
  return decodeExit(encoded);
}

function memoryBindings(
  memories: TestMemories
): ReadonlyMap<ResourceRef, WebAssembly.Memory> {
  return new Map([
    [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
    [testExecutionModel.guestMemory.resource, memories.guestMemory]
  ]);
}

function dispatchTargets(
  dispatches: readonly DispatchObservation[]
): readonly number[] {
  return dispatches.map((dispatch) => dispatch.targetEip);
}
