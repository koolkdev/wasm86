import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeJitBlock } from "#engines/jit/decode-block.js";
import {
  assertLazyFlagState,
  readWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";
import { compileActionWasmBlockHandle, type WasmBlockHandle } from "#engines/jit/block-handle.js";
import { writeBackingBytes } from "#memory/bytes.js";

const aEip = 0x1000;
const bEip = 0x2000;
const noFlags = { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;

test("unlinked final static jmp uses module-local fallback stub", () => {
  const fixture = createLinkingFixture([
    block(aEip, incEaxJmpRel32(aEip, bEip))
  ]);
  const a = compileBlock(fixture, aEip);

  const stateView = new DataView(fixture.memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: aEip });

  const run = a.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, { kind: "linkStub", targetEip: bEip });
  strictEqual(state.eip, bEip);
  strictEqual(state.eax, 1);
});

test("unlinked final static call uses module-local fallback stub", () => {
  const fixture = createLinkingFixture([
    block(aEip, incEaxCallRel32(aEip, bEip))
  ]);
  const a = compileBlock(fixture, aEip);

  const stateView = new DataView(fixture.memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: aEip, esp: 0x80 });

  const run = a.run();
  const state = readWasmCpuStateSnapshot(stateView);
  const returnAddress = aEip + incEaxCallRel32(aEip, bEip).length;

  deepStrictEqual(run.exit, { kind: "linkStub", targetEip: bEip });
  strictEqual(state.eip, bEip);
  strictEqual(state.eax, 1);
  strictEqual(state.esp, 0x7c);
  strictEqual(new DataView(fixture.memories.guestMemory.buffer).getUint32(0x7c, true), returnAddress);
});

// The pending map folds the moved constant into the jump target, so the
// indirect jump links exactly like a static one.
test("constant-folded indirect jump target uses module-local fallback stub", () => {
  const fixture = createLinkingFixture([
    block(aEip, movEaxJmpEax(bEip))
  ]);
  const a = compileBlock(fixture, aEip);

  const stateView = new DataView(fixture.memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: aEip });

  const run = a.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, { kind: "linkStub", targetEip: bEip });
  strictEqual(state.eax, bEip);
  strictEqual(state.eip, bEip);
});

test("unlinked final jmp rel8 uses module-local fallback stub", () => {
  const rel8A = 0x1100;
  const rel8B = 0x1108;
  const fixture = createLinkingFixture([
    block(rel8A, incEaxJmpRel8(rel8A, rel8B))
  ]);
  const a = compileBlock(fixture, rel8A);

  const stateView = new DataView(fixture.memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: rel8A });

  const run = a.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, { kind: "linkStub", targetEip: rel8B });
  strictEqual(state.eip, rel8B);
  strictEqual(state.eax, 1);
});

test("conditional side exit uses the module-local fallback only when taken", () => {
  const takenEip = aEip + 0x20;
  const branchBytes = incEaxJnzRel8(aEip, takenEip);
  const notTakenEip = aEip + branchBytes.length;
  const fixture = createLinkingFixture([
    block(aEip, [...branchBytes, ...incEaxHostTrap()])
  ]);
  const branch = compileBlock(fixture, aEip);

  const stateView = new DataView(fixture.memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: aEip });

  const takenRun = branch.run();
  const takenState = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(takenRun.exit, { kind: "linkStub", targetEip: takenEip });
  strictEqual(takenState.eip, takenEip);
  strictEqual(takenState.eax, 1);

  writeWasmCpuStateSnapshot(stateView, { eip: aEip, eax: 0xffff_ffff });

  const notTakenRun = branch.run();
  const notTakenState = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(notTakenRun.exit, { kind: "hostTrap", vector: 0x2e });
  strictEqual(notTakenState.eax, 1);
  strictEqual(notTakenState.eip, notTakenEip + incEaxHostTrap().length);
});

test("unlinked conditional side exits and local fallthrough preserve exit-store flag values", () => {
  const takenEip = aEip + 0x20;
  const branchBytes = addEaxOneJnzRel8(aEip, takenEip);
  const fixture = createLinkingFixture([
    block(aEip, [...branchBytes, ...hostTrap()])
  ]);
  const branch = compileBlock(fixture, aEip);

  const stateView = new DataView(fixture.memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: aEip, eax: 0 });

  const takenRun = branch.run();
  const takenState = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(takenRun.exit, { kind: "linkStub", targetEip: takenEip });
  strictEqual(takenState.eip, takenEip);
  strictEqual(takenState.eax, 1);
  deepStrictEqual(wasmCpuStatusFlagsOf(takenState), noFlags);
  assertLazyFlagState(takenState, { kind: "ADD", width: 32, a: 0, b: 1 }, "taken");

  writeWasmCpuStateSnapshot(stateView, { eip: aEip, eax: 0xffff_ffff });

  const notTakenRun = branch.run();
  const notTakenState = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(notTakenRun.exit, { kind: "hostTrap", vector: 0x2e });
  strictEqual(notTakenState.eax, 0);
  deepStrictEqual(wasmCpuStatusFlagsOf(notTakenState), noFlags);
  assertLazyFlagState(notTakenState, { kind: "ADD", width: 32, a: 0xffff_ffff, b: 1 }, "not taken");
});

function createLinkingFixture(blocks: readonly TestBlock[]): Readonly<{
  blocks: readonly TestBlock[];
  memories: ReturnType<typeof createTestWasmMemories>;
}> {
  const memories = createTestWasmMemories();

  return {
    blocks,
    memories
  };
}

function compileBlock(fixture: ReturnType<typeof createLinkingFixture>, eip: number): WasmBlockHandle {
  const source = fixture.blocks.find((testBlock) => testBlock.eip === eip);

  ok(source, `expected source bytes at 0x${eip.toString(16)}`);

  const firstFailingAddress = writeBackingBytes(
    fixture.memories.guestMemory,
    source.eip,
    source.bytes
  );

  ok(
    firstFailingAddress === undefined,
    `source bytes exceed guest memory at 0x${firstFailingAddress?.toString(16)}`
  );
  const decoded = decodeJitBlock(
    fixture.memories.guestMemory,
    eip,
    { maxInstructions: 1024 }
  );

  return compileActionWasmBlockHandle([decoded], {
    cpuStateMemory: fixture.memories.cpuStateMemory,
    guestMemory: fixture.memories.guestMemory
  });
}

function block(eip: number, bytes: readonly number[]): TestBlock {
  return { eip, bytes };
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

function rel8Instruction(opcode: number, eip: number, targetEip: number): readonly number[] {
  const displacement = targetEip - (eip + 2);

  if (displacement < -128 || displacement > 127) {
    throw new RangeError(`rel8 displacement out of range: ${displacement}`);
  }

  return [
    opcode,
    displacement & 0xff
  ];
}

function rel32Instruction(opcode: number, eip: number, targetEip: number): readonly number[] {
  const displacement = targetEip - (eip + 5);

  return [
    opcode,
    displacement & 0xff,
    (displacement >> 8) & 0xff,
    (displacement >> 16) & 0xff,
    (displacement >> 24) & 0xff
  ];
}

type TestBlock = Readonly<{
  eip: number;
  bytes: readonly number[];
}>;
