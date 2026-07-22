import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { encodeVariant } from "#compiler/layout/variant-codec.js";
import { instantiateCompiledProgram } from "#compiler/program/instance.js";
import { decodeExit, exitLayout } from "#cpu/exit.js";
import { compileJitFromMemory } from "#jit/compile.js";
import { instructionLimitExit } from "#interpreter/exits.js";
import { writeBackingBytes } from "#memory/bytes.js";
import {
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";

const aEip = 0x1000;
const bEip = 0x2000;
const dispatchStop = encodeVariant(exitLayout, instructionLimitExit());

test("a final static jmp returns through the typed dispatch import", () => {
  const memories = createTestWasmMemories();

  writeSource(memories.guestMemory, aEip, incEaxJmpRel32(aEip, bEip));
  const artifact = compileJitFromMemory({
    memory: memories.guestMemory,
    start: aEip,
    policy: { instructionLimit: 1024 },
    model: testExecutionModel
  });
  const imported = artifact.program.functionImports[0];

  strictEqual(artifact.program.functionImports.length, 1);
  ok(imported !== undefined, "compiled JIT artifact has no dispatch import");
  const dispatchTargets: number[] = [];
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
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
  const branchBytes = incEaxJnzRel8(aEip, takenEip);
  const notTakenEip = aEip + branchBytes.length;
  const memories = createTestWasmMemories();

  writeSource(
    memories.guestMemory,
    aEip,
    [...branchBytes, ...incEaxHostTrap()]
  );
  const artifact = compileJitFromMemory({
    memory: memories.guestMemory,
    start: aEip,
    policy: { instructionLimit: 1024 },
    model: testExecutionModel
  });
  const imported = artifact.program.functionImports[0];

  strictEqual(artifact.program.functionImports.length, 1);
  ok(imported !== undefined, "compiled JIT artifact has no dispatch import");
  const dispatchTargets: number[] = [];
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
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
  strictEqual(notTakenState.eip, notTakenEip + incEaxHostTrap().length);
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

function incEaxJmpRel32(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x40,
    ...jmpRel32(blockEip + 1, targetEip)
  ];
}

function incEaxJnzRel8(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x40,
    ...jnzRel8(blockEip + 1, targetEip)
  ];
}

function incEaxHostTrap(): readonly number[] {
  return [
    0x40,
    0xcd, 0x2e
  ];
}

function jmpRel32(eip: number, targetEip: number): readonly number[] {
  return rel32Instruction(0xe9, eip, targetEip);
}

function jnzRel8(eip: number, targetEip: number): readonly number[] {
  return rel8Instruction(0x75, eip, targetEip);
}

function rel8Instruction(
  opcode: number,
  eip: number,
  targetEip: number
): readonly number[] {
  const displacement = targetEip - (eip + 2);

  if (displacement < -128 || displacement > 127) {
    throw new RangeError(`rel8 displacement out of range: ${displacement}`);
  }

  return [
    opcode,
    displacement & 0xff
  ];
}

function rel32Instruction(
  opcode: number,
  eip: number,
  targetEip: number
): readonly number[] {
  const displacement = targetEip - (eip + 5);

  return [
    opcode,
    displacement & 0xff,
    (displacement >> 8) & 0xff,
    (displacement >> 16) & 0xff,
    (displacement >> 24) & 0xff
  ];
}
