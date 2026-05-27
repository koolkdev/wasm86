import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createCpuState } from "#x86/state/cpu-state.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { assertCompletedInstruction, assertSingleInstructionExit, executeInstruction } from "./support.js";

const preservedEflags = 0x0020_0000;
const allModeledEflags = 0x8d5;
const addWraparoundEflags = 0x55;
const subBorrowEflags = 0x95;
const zeroLogicEflags = 0x44;
const signLogicEflags = 0x84;

test("executes ADD r32, r/m32 and materializes add flags", async () => {
  const initialState = createCpuState({
    eax: 0xffff_ffff,
    ebx: 1,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x03, 0xc3], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  strictEqual(state.eflags, preservedEflags | addWraparoundEflags);
});

test("executes SUB r/m32, r32 and materializes sub flags", async () => {
  const initialState = createCpuState({
    eax: 0,
    ebx: 1,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x29, 0xd8], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_ffff);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  strictEqual(state.eflags, preservedEflags | subBorrowEflags);
});

test("executes XOR r/m32, r32 and materializes logic flags", async () => {
  const initialState = createCpuState({
    eax: 0x1234_5678,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x31, 0xc0], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  assertCompletedInstruction(state, startAddress + 2, 8);
  strictEqual(state.eflags, preservedEflags | zeroLogicEflags);
});

test("executes OR r32, r/m32 and materializes logic flags", async () => {
  const initialState = createCpuState({
    eax: 0x8000_0000,
    ebx: 0x100,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0b, 0xc3], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x8000_0100);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  strictEqual(state.eflags, preservedEflags | signLogicEflags);
});

test("executes AND r/m32, r32 and materializes logic flags", async () => {
  const initialState = createCpuState({
    eax: 0xffff_ffff,
    ebx: 0,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x21, 0xd8], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  strictEqual(state.eflags, preservedEflags | zeroLogicEflags);
});

test("executes CMP r/m32, r32 without writing operands", async () => {
  const initialState = createCpuState({
    eax: 5,
    ebx: 5,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x39, 0xd8], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  strictEqual(state.eflags, preservedEflags | zeroLogicEflags);
});

test("executes TEST r/m32, r32 without writing operands", async () => {
  const initialState = createCpuState({
    eax: 0x8000_0000,
    ebx: 0xffff_ffff,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x85, 0xd8], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  strictEqual(state.eflags, preservedEflags | signLogicEflags);
});
