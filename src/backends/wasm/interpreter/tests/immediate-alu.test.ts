import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createCpuState } from "#x86/state/cpu-state.js";
import {
  assertInterpreterStateEquals,
  writeInterpreterState
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { ExitReason } from "#wasm/exit.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  executeInstruction,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";

const preservedEflags = 0x0020_0000;
const allModeledEflags = 0x8d5;
const addWraparoundEflags = 0x55;
const subBorrowEflags = 0x95;
const zeroResultEflags = 0x44;
const carryAuxEflags = 0x11;
const parityOnlyEflags = 0x04;
const signParityEflags = 0x84;

test("executes ADD EAX, imm32", async () => {
  const initialState = createCpuState({
    eax: 0xffff_ffff,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x05, 0x01, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  assertCompletedInstruction(state, startAddress + 5, 8);
  strictEqual(state.eflags, preservedEflags | addWraparoundEflags);
});

test("executes SUB EAX, imm32", async () => {
  const initialState = createCpuState({
    eax: 0,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x2d, 0x01, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_ffff);
  assertCompletedInstruction(state, startAddress + 5, 8);
  strictEqual(state.eflags, preservedEflags | subBorrowEflags);
});

test("executes ADD AX, imm16 with 16-bit wraparound", async () => {
  const initialState = createCpuState({
    eax: 0xffff_0001,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x05, 0xff, 0xff], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_0000);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("executes ADD AX, imm16 without leaking carry into high EAX", async () => {
  const initialState = createCpuState({
    eax: 0x1234_ffff,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x05, 0x01, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_0000);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("executes SUB AX, imm16 without borrowing from high EAX", async () => {
  const initialState = createCpuState({
    eax: 0x1234_0000,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x2d, 0x01, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_ffff);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("executes ADD AL, imm8 without leaking carry into high EAX", async () => {
  const initialState = createCpuState({
    eax: 0xffff_00ff,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x04, 0x01], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_0000);
  assertCompletedInstruction(state, startAddress + 2, 8);
});

test("executes SUB AL, imm8 without borrowing from high EAX", async () => {
  const initialState = createCpuState({
    eax: 0xffff_0000,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x2c, 0x01], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_00ff);
  assertCompletedInstruction(state, startAddress + 2, 8);
});

test("executes XOR EAX, imm32", async () => {
  const initialState = createCpuState({
    eax: 0xffff_ffff,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x35, 0xff, 0xff, 0xff, 0xff], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  assertCompletedInstruction(state, startAddress + 5, 8);
  strictEqual(state.eflags, preservedEflags | zeroResultEflags);
});

test("executes OR EAX, imm32", async () => {
  const initialState = createCpuState({
    eax: 0x8000_0000,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0d, 0x00, 0x01, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x8000_0100);
  assertCompletedInstruction(state, startAddress + 5, 8);
  strictEqual(state.eflags, preservedEflags | signParityEflags);
});

test("executes AND EAX, imm32", async () => {
  const initialState = createCpuState({
    eax: 0xffff_ffff,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x25, 0x00, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  assertCompletedInstruction(state, startAddress + 5, 8);
  strictEqual(state.eflags, preservedEflags | zeroResultEflags);
});

test("executes CMP EAX, imm32 without writing EAX", async () => {
  const initialState = createCpuState({
    eax: 5,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x3d, 0x05, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  assertCompletedInstruction(state, startAddress + 5, 8);
  strictEqual(state.eflags, preservedEflags | zeroResultEflags);
});

test("executes TEST EAX, imm32 without writing EAX", async () => {
  const initialState = createCpuState({
    eax: 0xff,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0xa9, 0xff, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  assertCompletedInstruction(state, startAddress + 5, 8);
  strictEqual(state.eflags, preservedEflags | parityOnlyEflags);
});

test("executes 81 /7 CMP r/m32, imm32 for register operands", async () => {
  const initialState = createCpuState({
    eax: 0,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x81, 0xf8, 0x00, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  assertCompletedInstruction(state, startAddress + 6, 8);
  strictEqual(state.eflags, preservedEflags | zeroResultEflags);
});

test("executes 83 /5 SUB r/m32, sign-extended imm8 for register operands", async () => {
  const initialState = createCpuState({
    eax: 1,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x83, 0xe8, 0xff], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 2);
  assertCompletedInstruction(state, startAddress + 3, 8);
  strictEqual(state.eflags, preservedEflags | carryAuxEflags);
});

test("executes 83 /6 XOR r/m32, sign-extended imm8 for register operands", async () => {
  const initialState = createCpuState({
    eax: 0,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x83, 0xf0, 0xff], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_ffff);
  assertCompletedInstruction(state, startAddress + 3, 8);
  strictEqual(state.eflags, preservedEflags | signParityEflags);
});

test("executes 83 /4 AND r/m32, sign-extended imm8 for register operands", async () => {
  const initialState = createCpuState({
    eax: 0xffff_ffff,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x83, 0xe0, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  assertCompletedInstruction(state, startAddress + 3, 8);
  strictEqual(state.eflags, preservedEflags | zeroResultEflags);
});

test("unsupported 81 /2 group returns unsupported before immediate decode", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const eip = interpreter.guestView.byteLength - 2;
  const initialState = createCpuState({
    eax: 0x1234_5678,
    eip,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, eip, [0x81, 0xd0]);

  const exit = interpreter.run(1);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
