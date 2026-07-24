import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { encodeVariant } from "#compiler/layout/variant-codec.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import { decodeExit, exitLayout } from "#cpu/exit.js";
import { compileJitFromMemory } from "#jit/compile.js";
import { instructionLimitExit } from "#interpreter/exits.js";
import { writeBackingBytes } from "#memory/bytes.js";
import {
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  guestMemoryResource,
  testExecutionModel
} from "#test/support/execution-model.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";

const aEip = 0x1000;
const bEip = 0x2000;
const dispatchStop = encodeVariant(exitLayout, instructionLimitExit());

test("a final static jmp returns through the typed dispatch import", () => {
  const memories = createTestWasmMemories();

  writeSource(memories.guestMemory, aEip, [
    0x40,                         // inc eax
    0xe9, 0xfa, 0x0f, 0x00, 0x00 // jmp 0x2000
  ]);
  const artifact = compileJitFromMemory({
    memory: memories.guestMemory,
    start: aEip,
    policy: { instructionLimit: 1024 },
    model: testExecutionModel
  });
  const imported = artifact.program.functionImports[0];

  ok(imported !== undefined, "compiled JIT artifact has no dispatch import");
  const dispatchTargets: number[] = [];
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [guestMemoryResource, memories.guestMemory]
    ]),
    functions: new Map([[
      imported.ref,
      recordDispatches(dispatchTargets)
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);

  ok(typeof entry === "function", "compiled JIT entry export is not callable");
  const stateView = new DataView(memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: aEip });
  const encoded: unknown = entry();

  ok(typeof encoded === "bigint", "compiled JIT entry must return i64");
  deepStrictEqual(decodeExit(encoded), { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets, [bEip]);
  const state = readWasmCpuStateSnapshot(stateView);

  strictEqual(state.eip, bEip);
  strictEqual(state.eax, 1);
  strictEqual(state.instructionCount, 2);
});

test("a conditional side transfer dispatches only when taken", () => {
  const takenEip = aEip + 0x20;
  const memories = createTestWasmMemories();

  writeSource(
    memories.guestMemory,
    aEip,
    [
      0x40,       // inc eax
      0x75, 0x1d, // jnz 0x1020
      0x40,       // inc eax
      0xcd, 0x2e  // int 0x2e
    ]
  );
  const artifact = compileJitFromMemory({
    memory: memories.guestMemory,
    start: aEip,
    policy: { instructionLimit: 1024 },
    model: testExecutionModel
  });
  const imported = artifact.program.functionImports[0];

  ok(imported !== undefined, "compiled JIT artifact has no dispatch import");
  const dispatchTargets: number[] = [];
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [guestMemoryResource, memories.guestMemory]
    ]),
    functions: new Map([[
      imported.ref,
      recordDispatches(dispatchTargets)
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);

  ok(typeof entry === "function", "compiled JIT entry export is not callable");
  const stateView = new DataView(memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: aEip });
  const takenEncoded: unknown = entry();

  ok(
    typeof takenEncoded === "bigint",
    "compiled JIT entry must return i64"
  );
  deepStrictEqual(decodeExit(takenEncoded), { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets, [takenEip]);
  const takenState = readWasmCpuStateSnapshot(stateView);

  strictEqual(takenState.eip, takenEip);
  strictEqual(takenState.eax, 1);

  writeWasmCpuStateSnapshot(stateView, { eip: aEip, eax: 0xffff_ffff });
  const notTakenEncoded: unknown = entry();

  ok(
    typeof notTakenEncoded === "bigint",
    "compiled JIT entry must return i64"
  );
  deepStrictEqual(
    decodeExit(notTakenEncoded),
    { kind: "hostTrap", vector: 0x2e }
  );
  deepStrictEqual(dispatchTargets, [takenEip]);
  const notTakenState = readWasmCpuStateSnapshot(stateView);

  strictEqual(notTakenState.eax, 1);
  strictEqual(notTakenState.eip, aEip + 6);
});

test("an indirect jump preserves the full u32 dispatch target", () => {
  const targetEip = 0xf000_4000;
  const memories = createTestWasmMemories();

  writeSource(memories.guestMemory, aEip, [0xff, 0xe0]); // jmp eax
  const artifact = compileJitFromMemory({
    memory: memories.guestMemory,
    start: aEip,
    policy: { instructionLimit: 1 },
    model: testExecutionModel
  });
  const imported = artifact.program.functionImports[0];

  ok(imported !== undefined, "compiled JIT artifact has no dispatch import");
  const dispatchTargets: number[] = [];
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [guestMemoryResource, memories.guestMemory]
    ]),
    functions: new Map([[
      imported.ref,
      recordDispatches(dispatchTargets)
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);

  ok(typeof entry === "function", "compiled JIT entry export is not callable");
  const stateView = new DataView(memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: aEip, eax: targetEip });
  const encoded: unknown = entry();

  ok(typeof encoded === "bigint", "compiled JIT entry must return i64");
  deepStrictEqual(decodeExit(encoded), { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets, [targetEip]);
});

function writeSource(
  memory: WebAssembly.Memory,
  eip: number,
  bytes: readonly number[]
): void {
  const firstFailingAddress = writeBackingBytes(
    memory,
    eip,
    bytes
  );

  ok(
    firstFailingAddress === undefined,
    `source bytes exceed guest memory at 0x${firstFailingAddress?.toString(16)}`
  );
}

function recordDispatches(
  dispatchTargets: number[]
): (targetEip: number) => bigint {
  return (targetEip) => {
    dispatchTargets.push(targetEip >>> 0);
    return dispatchStop;
  };
}
