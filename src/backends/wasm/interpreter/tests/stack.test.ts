import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createCpuState, type CpuState } from "#x86/state/cpu-state.js";
import {
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
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
