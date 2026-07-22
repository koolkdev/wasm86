import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmOpcode } from "#compiler/encoder/types.js";
import { encodeVariant } from "#compiler/layout/variant-codec.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import { instantiateCompiledProgram } from "#compiler/program/instance.js";
import type { FunctionRef } from "#compiler/program/refs.js";
import { invalidOpcode, pageFault } from "#core/exceptions.js";
import { x86Flags } from "#core/flags/definitions.js";
import { flagStateFields } from "#core/flags/layout.js";
import { coreStateFields } from "#core/state/layout.js";
import type { RunStop } from "#cpu/cpu.js";
import { decodeExit, exitLayout } from "#cpu/exit.js";
import {
  compileJitFromMemory,
  type CompiledJitArtifact
} from "#jit/compile.js";
import { instructionLimitExit } from "#interpreter/exits.js";
import {
  extractOnlyWasmFunctionBody,
  wasmBodyMemoryAccesses,
  wasmBodyOpcodes,
  wasmDefinedFunctionCount
} from "#compiler/encoder/tests/body-opcodes.js";
import {
  readWasmCpuStateSnapshot,
  type WasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";
import { jitMemoryWithBytes } from "./decode-helpers.js";

const startEip = 0x1000;
const encodedDispatchStop = encodeVariant(
  exitLayout,
  instructionLimitExit()
);

test("JIT closure emits only resolver functions reached by symbolic instructions", () => {
  const ordinary = compileArtifact([0x90], 1);
  // seta al reads CF and ZF when the block has no pending flag source.
  const withResolvers = compileArtifact(
    [0x0f, 0x97, 0xc0, 0xcd, 0x2e],
    2
  );

  strictEqual(wasmDefinedFunctionCount(ordinary.program.bytes), 1);
  strictEqual(wasmDefinedFunctionCount(withResolvers.program.bytes), 3);
  // The terminal INT has no guest-transfer path, so its unused dispatch
  // declaration is removed by ordinary function-import closure.
  strictEqual(withResolvers.program.functionImports.length, 0);
});

test("JIT compiles a decode-time CPU exception after decoded instructions", () => {
  const artifact = compileArtifact([0x40, 0x62], 2);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const dispatches: DispatchObservation[] = [];

  strictEqual(artifact.program.functionImports.length, 0);
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
    exception: invalidOpcode()
  });
  deepStrictEqual(dispatches, []);
  strictEqual(state.eax, 5);
  strictEqual(state.eip, startEip + 1);
  strictEqual(state.instructionCount, 1);
});

test("an empty decode-time CPU exception commits its instruction start", () => {
  const artifact = compileArtifact([0x62], 1);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const dispatches: DispatchObservation[] = [];

  strictEqual(artifact.program.functionImports.length, 0);
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
    exception: invalidOpcode()
  });
  deepStrictEqual(dispatches, []);
  strictEqual(state.eip, startEip);
  strictEqual(state.instructionCount, 0);
});

test("a repeated add retains one physical eax read and write before fallthrough dispatch", () => {
  // add eax, 1; add eax, 1.
  const artifact = compileArtifact(
    [0x83, 0xc0, 0x01, 0x83, 0xc0, 0x01],
    2
  );
  const body = extractOnlyWasmFunctionBody(artifact.program.bytes);
  const accesses = wasmBodyMemoryAccesses(body);
  const cpuMemoryIndex = artifact.program.memoryImports.findIndex(
    (memory) => memory.ref === testExecutionModel.cpuState.resource
  );
  const gprs = testExecutionModel.cpuState.layout.array(coreStateFields.gprs);
  const eaxOffset = gprs.offset;
  const eaxAccesses = accesses.filter(
    (access) => access.memoryIndex === cpuMemoryIndex && access.offset === eaxOffset
  );

  ok(cpuMemoryIndex >= 0, "compiled block has no CPU-state memory import");
  strictEqual(
    eaxAccesses.filter((access) => access.opcode === wasmOpcode.i32Load).length,
    1
  );
  strictEqual(
    eaxAccesses.filter((access) => access.opcode === wasmOpcode.i32Store).length,
    1
  );

  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const dispatches: DispatchObservation[] = [];
  const imported = artifact.program.functionImports[0];

  strictEqual(artifact.program.functionImports.length, 1);
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

test("cross-instruction dead concrete flag writes stay absent", () => {
  const artifact = compileArtifact(
    [0x83, 0xc0, 0x01, 0x83, 0xc0, 0x01],
    2
  );
  const accesses = wasmBodyMemoryAccesses(
    extractOnlyWasmFunctionBody(artifact.program.bytes)
  );
  const cpuMemoryIndex = artifact.program.memoryImports.findIndex(
    (memory) => memory.ref === testExecutionModel.cpuState.resource
  );
  const concreteFlagOffsets = new Set(
    x86Flags.map((flag) =>
      testExecutionModel.cpuState.layout.field(
        flagStateFields.concrete[flag]
      ).offset
    )
  );
  const lazyKindOffset = testExecutionModel.cpuState.layout.field(
    flagStateFields.lazyKind
  ).offset;
  const stores = accesses.filter(
    (access) => access.memoryIndex === cpuMemoryIndex && isStore(access.opcode)
  );

  strictEqual(
    stores.filter((access) => concreteFlagOffsets.has(access.offset)).length,
    0
  );
  strictEqual(
    stores.filter((access) => access.offset === lazyKindOffset).length,
    1
  );
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
  const dispatches: DispatchObservation[] = [];

  strictEqual(artifact.program.functionImports.length, 0);
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
    exception: pageFault(faultAddress, 0)
  });
  deepStrictEqual(dispatches, []);
  strictEqual(state.eax, 6);
  strictEqual(state.eip, startEip + 1);
  strictEqual(state.instructionCount, 1);
});


test("a backward side transfer lowers to return_call and dispatches once", () => {
  // sub ecx, 1; jnz start; int 0x2e.
  const artifact = compileArtifact([
    0x83, 0xe9, 0x01,
    0x75, 0xfb,
    0xcd, 0x2e
  ], 3);
  const opcodes = wasmBodyOpcodes(
    extractOnlyWasmFunctionBody(artifact.program.bytes)
  );
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const dispatches: DispatchObservation[] = [];
  const imported = artifact.program.functionImports[0];

  strictEqual(opcodes.includes(wasmOpcode.returnCall), true);
  strictEqual(artifact.program.functionImports.length, 1);
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

  strictEqual(artifact.program.functionImports.length, 1);
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

test("straight-line fallthrough dispatches exactly once with committed state", () => {
  const artifact = compileArtifact([0x40], 1);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const dispatches: DispatchObservation[] = [];
  const imported = artifact.program.functionImports[0];

  strictEqual(artifact.program.functionImports.length, 1);
  ok(imported !== undefined, "fallthrough block has no dispatch import");
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: memoryBindings(memories),
    functions: new Map<FunctionRef, Function>([[
      imported.ref,
      createDispatchRecorder(memories, dispatches)
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, eax: 9 });
  ok(typeof entry === "function", "compiled JIT entry is not callable");
  const exit = decodeEntryResult(entry());

  deepStrictEqual(exit, { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets(dispatches), [startEip + 1]);
  strictEqual(dispatches[0]?.state.eax, 10);
  strictEqual(dispatches[0]?.state.eip, startEip + 1);
  strictEqual(dispatches[0]?.state.instructionCount, 1);
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

function isStore(opcode: number): boolean {
  return opcode === wasmOpcode.i32Store ||
    opcode === wasmOpcode.i32Store8 ||
    opcode === wasmOpcode.i32Store16;
}
