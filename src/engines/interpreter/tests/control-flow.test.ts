import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState
} from "./interpreter-helpers.js";
import { startAddress } from "#test/support/addresses.js";
import { fetchPageFaultStop } from "#cpu/tests/stop-fixtures.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  executeInstruction,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";


test("executes JMP rel8 to nextEip plus signed displacement", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0xeb, 0x02], initialState);

  assertSingleInstructionExit(exit);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("continues the interpreter loop after JMP while fuel remains", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [
    0xeb, 0x02,
    0x00, 0x00,
    0xb8, 0x78, 0x56, 0x34, 0x12
  ]);

  const exit = interpreter.run(2);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_5678);
  assertCompletedInstruction(state, startAddress + 9, 9);
});

test("executes JMP rel32 to nextEip plus signed displacement", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0xe9, 0xfc, 0xff, 0xff, 0xff], initialState);

  assertSingleInstructionExit(exit);
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes operand-size JMP rel16 to nextEip plus signed displacement", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0xe9, 0xfc, 0xff], initialState);

  assertSingleInstructionExit(exit);
  assertCompletedInstruction(state, startAddress, 8);
});

test("executes JNE rel8 taken when ZF is clear", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x75, 0x02], initialState);

  assertSingleInstructionExit(exit);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("executes JNE rel8 fallthrough when ZF is set", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    ZF: 1,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x75, 0x02], initialState);

  assertSingleInstructionExit(exit);
  assertCompletedInstruction(state, startAddress + 2, 8);
});

test("executes operand-size JNE rel16 taken when ZF is clear", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x0f, 0x85, 0x02, 0x00], initialState);

  assertSingleInstructionExit(exit);
  assertCompletedInstruction(state, startAddress + 7, 8);
});

test("executes operand-size JNE rel16 fallthrough when ZF is set", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    ZF: 1,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x0f, 0x85, 0x02, 0x00], initialState);

  assertSingleInstructionExit(exit);
  assertCompletedInstruction(state, startAddress + 5, 8);
});

test("executes JNE rel32 with the same condition as rel8", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0f, 0x85, 0x02, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  assertCompletedInstruction(state, startAddress + 8, 8);
});

test("truncated JMP rel32 returns decode fault without changing architectural state", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const eip = interpreter.guestView.byteLength - 4;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    eip,
    ZF: 1,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, eip, [0xe9, 0x01, 0x02, 0x03]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 1));
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
