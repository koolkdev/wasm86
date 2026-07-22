import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { encodeVariant } from "#compiler/layout/variant-codec.js";
import { instantiateCompiledProgram } from "#compiler/program/instance.js";
import { decodeExit, exitLayout } from "#cpu/exit.js";
import { compileJitFromMemory } from "#engines/jit/compile.js";
import { instructionLimitExit } from "#interpreter/exits.js";
import { writeBackingBytes } from "#memory/bytes.js";
import {
  assertLazyFlagState,
  readWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";

const aEip = 0x1000;
const bEip = 0x2000;
const dispatchStop = encodeVariant(exitLayout, instructionLimitExit());
const noFlags = { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;

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

test("a final static call commits its stack state before typed dispatch", () => {
  const bytes = incEaxCallRel32(aEip, bEip);
  const memories = createTestWasmMemories();

  writeSource(memories.guestMemory, aEip, bytes);
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

  writeWasmCpuStateSnapshot(stateView, { eip: aEip, esp: 0x80 });
  const encoded: unknown = entry();

  ok(typeof encoded === "bigint", "compiled JIT entry must return i64");
  deepStrictEqual(decodeExit(encoded), { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets, [bEip]);
  const state = readWasmCpuStateSnapshot(stateView);
  const returnAddress = aEip + bytes.length;

  strictEqual(state.eip, bEip);
  strictEqual(state.eax, 1);
  strictEqual(state.esp, 0x7c);
  strictEqual(state.instructionCount, 2);
  strictEqual(
    new DataView(memories.guestMemory.buffer).getUint32(0x7c, true),
    returnAddress
  );
});

test("RET imm16 commits its popped target and unsigned stack adjustment before dispatch", () => {
  const targetEip = 0xf234_5678;
  const initialEsp = 0x80;
  const stackAdjustment = 0x8034;
  const expectedEsp = initialEsp + 4 + stackAdjustment;
  const memories = createTestWasmMemories();

  writeSource(
    memories.guestMemory,
    aEip,
    [0xc2, stackAdjustment & 0xff, stackAdjustment >>> 8]
  );
  new DataView(memories.guestMemory.buffer).setUint32(
    initialEsp,
    targetEip,
    true
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
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  let stateAtDispatch:
    | ReturnType<typeof readWasmCpuStateSnapshot>
    | undefined;
  const instance = instantiateCompiledProgram(artifact.program, {
    memories: new Map([
      [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
      [testExecutionModel.guestMemory.resource, memories.guestMemory]
    ]),
    functions: new Map([[
      imported.ref,
      (target: number): bigint => {
        dispatchTargets.push(target >>> 0);
        stateAtDispatch = readWasmCpuStateSnapshot(stateView);
        return dispatchStop;
      }
    ]])
  });
  const entry = instance.functionExports.get(artifact.entry);

  ok(typeof entry === "function", "compiled JIT entry export is not callable");
  writeWasmCpuStateSnapshot(stateView, {
    eip: aEip,
    esp: initialEsp,
    instructionCount: 7
  });
  const encoded: unknown = entry();

  ok(typeof encoded === "bigint", "compiled JIT entry must return i64");
  deepStrictEqual(decodeExit(encoded), { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets, [targetEip]);
  ok(stateAtDispatch !== undefined, "dispatch did not observe committed state");
  strictEqual(stateAtDispatch.eip, targetEip);
  strictEqual(stateAtDispatch.esp, expectedEsp);
  strictEqual(stateAtDispatch.instructionCount, 8);
});

test("a constant-folded indirect jump uses the typed dispatch import", () => {
  const memories = createTestWasmMemories();

  writeSource(memories.guestMemory, aEip, movEaxJmpEax(bEip));
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

  strictEqual(state.eax, bEip);
  strictEqual(state.eip, bEip);
});

test("a final jmp rel8 uses the typed dispatch import", () => {
  const rel8A = 0x1100;
  const rel8B = 0x1108;
  const memories = createTestWasmMemories();

  writeSource(memories.guestMemory, rel8A, incEaxJmpRel8(rel8A, rel8B));
  const artifact = compileJitFromMemory({
    memory: memories.guestMemory,
    start: rel8A,
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

  writeWasmCpuStateSnapshot(stateView, { eip: rel8A });
  const encoded: unknown = entry();

  ok(typeof encoded === "bigint", "compiled JIT entry must return i64");
  deepStrictEqual(decodeExit(encoded), { kind: "instructionLimit" });
  deepStrictEqual(dispatchTargets, [rel8B]);
  const state = readWasmCpuStateSnapshot(stateView);

  strictEqual(state.eip, rel8B);
  strictEqual(state.eax, 1);
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

test("conditional dispatch preserves completed lazy-flag state", () => {
  const takenEip = aEip + 0x20;
  const branchBytes = addEaxOneJnzRel8(aEip, takenEip);
  const memories = createTestWasmMemories();

  writeSource(
    memories.guestMemory,
    aEip,
    [...branchBytes, ...hostTrap()]
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

  writeWasmCpuStateSnapshot(stateView, { eip: aEip, eax: 0 });
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
  deepStrictEqual(wasmCpuStatusFlagsOf(takenState), noFlags);
  assertLazyFlagState(
    takenState,
    { kind: "ADD", width: 32, a: 0, b: 1 },
    "taken"
  );

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

  strictEqual(notTakenState.eax, 0);
  deepStrictEqual(wasmCpuStatusFlagsOf(notTakenState), noFlags);
  assertLazyFlagState(
    notTakenState,
    { kind: "ADD", width: 32, a: 0xffff_ffff, b: 1 },
    "not taken"
  );
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

function incEaxCallRel32(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x40,
    ...callRel32(blockEip + 1, targetEip)
  ];
}

function incEaxJmpRel8(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x40,
    ...jmpRel8(blockEip + 1, targetEip)
  ];
}

function incEaxJnzRel8(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x40,
    ...jnzRel8(blockEip + 1, targetEip)
  ];
}

function movEaxJmpEax(targetEip: number): readonly number[] {
  return [
    0xb8,
    targetEip & 0xff,
    (targetEip >>> 8) & 0xff,
    (targetEip >>> 16) & 0xff,
    (targetEip >>> 24) & 0xff,
    0xff, 0xe0
  ];
}

function addEaxOneJnzRel8(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x83, 0xc0, 0x01,
    ...jnzRel8(blockEip + 3, targetEip)
  ];
}

function incEaxHostTrap(): readonly number[] {
  return [
    0x40,
    0xcd, 0x2e
  ];
}

function hostTrap(): readonly number[] {
  return [0xcd, 0x2e];
}

function callRel32(eip: number, targetEip: number): readonly number[] {
  return rel32Instruction(0xe8, eip, targetEip);
}

function jmpRel32(eip: number, targetEip: number): readonly number[] {
  return rel32Instruction(0xe9, eip, targetEip);
}

function jmpRel8(eip: number, targetEip: number): readonly number[] {
  return rel8Instruction(0xeb, eip, targetEip);
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
