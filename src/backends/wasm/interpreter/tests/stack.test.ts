import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createCpuState, type CpuState } from "#x86/state/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { ExitReason } from "#wasm/exit.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";

type StackRunResult = Readonly<{
  interpreter: InterpreterModuleInstance;
  state: CpuState;
}>;

async function executeStackInstruction(
  bytes: readonly number[],
  initialState: CpuState,
  setupGuest?: (view: DataView) => void
): Promise<StackRunResult> {
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, bytes);
  setupGuest?.(interpreter.guestView);

  const exit = interpreter.run(1);

  assertSingleInstructionExit(exit);
  return {
    interpreter,
    state: readInterpreterState(interpreter.stateView)
  };
}

test("executes PUSH r32 by decrementing ESP and storing the value", async () => {
  const initialState = createCpuState({
    eax: 0x1122_3344,
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction([0x50], initialState);

  strictEqual(state.eax, initialState.eax);
  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint32(0x3c, true), 0x1122_3344);
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes PUSH sign-extended imm8", async () => {
  const initialState = createCpuState({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction([0x6a, 0xff], initialState);

  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint32(0x3c, true), 0xffff_ffff);
  assertCompletedInstruction(state, startAddress + 2, 8);
});

test("executes POP r32 by loading from ESP then incrementing ESP", async () => {
  const initialState = createCpuState({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeStackInstruction(
    [0x58],
    initialState,
    (guest) => guest.setUint32(0x40, 0x5566_7788, true)
  );

  strictEqual(state.eax, 0x5566_7788);
  strictEqual(state.esp, 0x44);
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes POP ESP with popped value as final ESP", async () => {
  const initialState = createCpuState({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeStackInstruction(
    [0x5c],
    initialState,
    (guest) => guest.setUint32(0x40, 0x80, true)
  );

  strictEqual(state.esp, 0x80);
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes LEAVE by restoring EBP and ESP from the frame", async () => {
  const initialState = createCpuState({
    ebp: 0x40,
    esp: 0x20,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeStackInstruction(
    [0xc9],
    initialState,
    (guest) => guest.setUint32(0x40, 0x5566_7788, true)
  );

  strictEqual(state.ebp, 0x5566_7788);
  strictEqual(state.esp, 0x44);
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes POP [ESP] by writing at the incremented ESP", async () => {
  const initialState = createCpuState({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction(
    [0x8f, 0x04, 0x24],
    initialState,
    (guest) => guest.setUint32(0x40, 0x5566_7788, true)
  );

  strictEqual(state.esp, 0x44);
  strictEqual(interpreter.guestView.getUint32(0x44, true), 0x5566_7788);
  assertCompletedInstruction(state, startAddress + 3, 8);
});

test("executes POP [ESP + disp8] against the incremented ESP", async () => {
  const initialState = createCpuState({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction(
    [0x8f, 0x44, 0x24, 0x08],
    initialState,
    (guest) => guest.setUint32(0x40, 0x5566_7788, true)
  );

  strictEqual(state.esp, 0x44);
  strictEqual(interpreter.guestView.getUint32(0x4c, true), 0x5566_7788);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("a faulting POP [mem] write leaves ESP, EIP, and the stack untouched", async () => {
  const initialState = createCpuState({
    ebx: 0xfffd,
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, [0x8f, 0x03]);
  interpreter.guestView.setUint32(0x40, 0x5566_7788, true);

  const exit = interpreter.run(1);

  // The destination write guard faults after the handler already advanced
  // esp on the main path; the fault edge must restore it.
  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_WRITE_FAULT, payload: 0xfffd, detail: 4 });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
  strictEqual(interpreter.guestView.getUint32(0x40, true), 0x5566_7788);
});

test("executes PUSH [ESP] by reading the source before writing the new stack slot", async () => {
  const initialState = createCpuState({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction(
    [0xff, 0x34, 0x24],
    initialState,
    (guest) => guest.setUint32(0x40, 0xaabb_ccdd, true)
  );

  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint32(0x3c, true), 0xaabb_ccdd);
  strictEqual(interpreter.guestView.getUint32(0x40, true), 0xaabb_ccdd);
  assertCompletedInstruction(state, startAddress + 3, 8);
});
