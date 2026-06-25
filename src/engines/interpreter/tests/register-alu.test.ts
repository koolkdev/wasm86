import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { assertLazyFlagState, createWasmCpuStateSnapshot, wasmCpuStatusFlagsOf } from "#runtime/tests/fixtures/cpu-state.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { assertCompletedInstruction, assertSingleInstructionExit, executeInstruction } from "./support.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

test("executes ADD r32, r/m32 and commits lazy add flags", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_ffff,
    ebx: 1,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x03, 0xc3], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "ADD", width: 32, a: 0xffff_ffff, b: 1 });
});

test("executes SUB r/m32, r32 and commits lazy sub flags", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    ebx: 1,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x29, 0xd8], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_ffff);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "SUB", width: 32, a: 0, b: 1 });
});

test("executes XOR r/m32, r32 and commits lazy logic flags", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x31, 0xc0], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "LOGIC_RESULT", width: 32, a: 0 });
});

test("executes OR r32, r/m32 and commits lazy logic flags", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x8000_0000,
    ebx: 0x100,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0b, 0xc3], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x8000_0100);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "LOGIC_RESULT", width: 32, a: 0x8000_0100 });
});

test("executes AND r/m32, r32 and commits lazy logic flags", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_ffff,
    ebx: 0,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x21, 0xd8], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "LOGIC_RESULT", width: 32, a: 0 });
});

test("executes CMP r/m32, r32 without writing operands", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 5,
    ebx: 5,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x39, 0xd8], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "SUB", width: 32, a: 5, b: 5 });
});

test("executes TEST r/m32, r32 without writing operands", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x8000_0000,
    ebx: 0xffff_ffff,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x85, 0xd8], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "LOGIC_RESULT", width: 32, a: 0x8000_0000 });
});
