import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ExitReason } from "#wasm/exit.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { maxX86InstructionLength } from "#x86/decoder/reader.js";
import { createCpuState, type CpuState } from "#x86/state/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
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
const signLogicEflags = 0x84;

test("executes MOV into AL, AH, and prefixed AX register views", async () => {
  const movAl = await executeInstruction([0xb0, 0x44], createCpuState({
    eax: 0x1122_3300,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(movAl.exit);
  strictEqual(movAl.state.eax, 0x1122_3344);
  assertCompletedInstruction(movAl.state, startAddress + 2, 8);

  const movAh = await executeInstruction([0xb4, 0x55], createCpuState({
    eax: 0x1122_0033,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(movAh.exit);
  strictEqual(movAh.state.eax, 0x1122_5533);
  assertCompletedInstruction(movAh.state, startAddress + 2, 8);

  const movAx = await executeInstruction([0x66, 0xb8, 0x78, 0x56], createCpuState({
    eax: 0x1234_0000,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(movAx.exit);
  strictEqual(movAx.state.eax, 0x1234_5678);
  assertCompletedInstruction(movAx.state, startAddress + 4, 8);
});

test("repeated operand-size prefixes still execute the 16-bit form once", async () => {
  const { exit, state } = await executeInstruction([0x66, 0x66, 0xb8, 0x34, 0x12], createCpuState({
    eax: 0xffff_0000,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_1234);
  assertCompletedInstruction(state, startAddress + 5, 8);
});

test("maximum length repeated operand-size prefixes still execute", async () => {
  const bytes = [...new Array<number>(12).fill(0x66), 0xb8, 0x34, 0x12];
  const { exit, state } = await executeInstruction(bytes, createCpuState({
    eax: 0xffff_0000,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_1234);
  assertCompletedInstruction(state, startAddress + maxX86InstructionLength, 8);
});

test("overlong prefixed instructions return decode faults", async () => {
  const immediateCrossesLimit = await executeInstruction(
    [...new Array<number>(13).fill(0x66), 0xb8, 0x34, 0x12],
    createCpuState({
      eax: 0x1122_3344,
      eip: startAddress,
      instructionCount: 7
    })
  );

  deepStrictEqual(immediateCrossesLimit.exit, {
    exitReason: ExitReason.DECODE_FAULT,
    payload: startAddress + maxX86InstructionLength
  });
  strictEqual(immediateCrossesLimit.state.eax, 0x1122_3344);
  assertCompletedInstruction(immediateCrossesLimit.state, startAddress, 7);

  const prefixLoopCrossesLimit = await executeInstruction(
    new Array<number>(15).fill(0x66),
    createCpuState({
      eax: 0x5566_7788,
      eip: startAddress,
      instructionCount: 7
    })
  );

  deepStrictEqual(prefixLoopCrossesLimit.exit, {
    exitReason: ExitReason.DECODE_FAULT,
    payload: startAddress + maxX86InstructionLength
  });
  strictEqual(prefixLoopCrossesLimit.state.eax, 0x5566_7788);
  assertCompletedInstruction(prefixLoopCrossesLimit.state, startAddress, 7);
});

test("executes byte and word memory reads and writes", async () => {
  const byteStore = await executeWithGuest([0x88, 0x03], createCpuState({
    eax: 0xaabb_ccdd,
    ebx: 0x40,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(byteStore.exit);
  strictEqual(byteStore.interpreter.guestView.getUint8(0x40), 0xdd);
  assertCompletedInstruction(byteStore.state, startAddress + 2, 8);

  const wordLoad = await executeWithGuest(
    [0x66, 0x8b, 0x03],
    createCpuState({
      eax: 0xffff_0000,
      ebx: 0x40,
      eip: startAddress,
      instructionCount: 7
    }),
    (guest) => guest.setUint16(0x40, 0x1234, true)
  );

  assertSingleInstructionExit(wordLoad.exit);
  strictEqual(wordLoad.state.eax, 0xffff_1234);
  assertCompletedInstruction(wordLoad.state, startAddress + 3, 8);

  const wordStore = await executeWithGuest([0x66, 0x89, 0x03], createCpuState({
    eax: 0xaaaa_babe,
    ebx: 0x44,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(wordStore.exit);
  strictEqual(wordStore.interpreter.guestView.getUint16(0x44, true), 0xbabe);
  strictEqual(wordStore.interpreter.guestView.getUint8(0x46), 0);
  assertCompletedInstruction(wordStore.state, startAddress + 3, 8);
});

test("materializes representative 8/16-bit ALU flags", async () => {
  const add8 = await executeInstruction([0x04, 0x01], createCpuState({
    eax: 0xffff_ffff,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  }));

  assertSingleInstructionExit(add8.exit);
  strictEqual(add8.state.eax, 0xffff_ff00);
  strictEqual(add8.state.eflags, preservedEflags | addWraparoundEflags);

  const sub16 = await executeInstruction([0x66, 0x2d, 0x01, 0x00], createCpuState({
    eax: 0xffff_0000,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  }));

  assertSingleInstructionExit(sub16.exit);
  strictEqual(sub16.state.eax, 0xffff_ffff);
  strictEqual(sub16.state.eflags, preservedEflags | subBorrowEflags);

  const cmp8 = await executeInstruction([0x3c, 0x80], createCpuState({
    eax: 0x80,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  }));

  assertSingleInstructionExit(cmp8.exit);
  strictEqual(cmp8.state.eax, 0x80);
  strictEqual(cmp8.state.eflags, preservedEflags | zeroResultEflags);

  const test16 = await executeInstruction([0x66, 0xa9, 0x00, 0x80], createCpuState({
    eax: 0x8000,
    eip: startAddress,
    eflags: preservedEflags | allModeledEflags,
    instructionCount: 7
  }));

  assertSingleInstructionExit(test16.exit);
  strictEqual(test16.state.eax, 0x8000);
  strictEqual(test16.state.eflags, preservedEflags | signLogicEflags);
});

test("unsupported prefixed opcode streams terminate without changing architectural state", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createCpuState({
    eax: 0x1122_3344,
    eip: startAddress,
    instructionCount: 7
  });

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x66, 0x66, 0x62]);

  const exit = interpreter.run(1);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

async function executeWithGuest(
  bytes: readonly number[],
  initialState: CpuState,
  setupGuest?: (view: DataView) => void
): Promise<Readonly<{
  exit: ReturnType<InterpreterModuleInstance["run"]>;
  interpreter: InterpreterModuleInstance;
  state: CpuState;
}>> {
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, bytes);
  setupGuest?.(interpreter.guestView);

  const exit = interpreter.run(1);

  return {
    exit,
    interpreter,
    state: readInterpreterState(interpreter.stateView)
  };
}
