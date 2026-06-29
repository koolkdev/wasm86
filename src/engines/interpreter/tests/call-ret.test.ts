import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot, type WasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import {
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
import {
  assertSingleInstructionExit,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";

type ControlRunResult = Readonly<{
  interpreter: InterpreterModuleInstance;
  state: WasmCpuStateSnapshot;
}>;

async function executeControlInstruction(
  bytes: readonly number[],
  initialState: WasmCpuStateSnapshot,
  setupGuest?: (view: DataView) => void
): Promise<ControlRunResult> {
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

test("executes CALL rel32 by pushing next EIP and jumping to the target", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeControlInstruction(
    [0xe8, 0x0b, 0x00, 0x00, 0x00],
    initialState
  );

  strictEqual(state.eip, startAddress + 0x10);
  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint32(0x3c, true), startAddress + 5);
  strictEqual(state.instructionCount, 8);
});

test("executes operand-size CALL rel16 by pushing next IP and jumping to the target", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeControlInstruction(
    [0x66, 0xe8, 0x0b, 0x00],
    initialState
  );

  strictEqual(state.eip, startAddress + 0x0f);
  strictEqual(state.esp, 0x3e);
  strictEqual(interpreter.guestView.getUint16(0x3e, true), startAddress + 4);
  strictEqual(state.instructionCount, 8);
});

test("executes CALL [ESP] by resolving the target before pushing the return address", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeControlInstruction(
    [0xff, 0x14, 0x24],
    initialState,
    (guest) => guest.setUint32(0x40, 0x1234, true)
  );

  strictEqual(state.eip, 0x1234);
  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint32(0x3c, true), startAddress + 3);
  strictEqual(interpreter.guestView.getUint32(0x40, true), 0x1234);
  strictEqual(state.instructionCount, 8);
});

test("executes operand-size CALL [ESP] by reading a word target before pushing", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeControlInstruction(
    [0x66, 0xff, 0x14, 0x24],
    initialState,
    (guest) => guest.setUint16(0x40, 0x2345, true)
  );

  strictEqual(state.eip, 0x2345);
  strictEqual(state.esp, 0x3e);
  strictEqual(interpreter.guestView.getUint16(0x3e, true), startAddress + 4);
  strictEqual(interpreter.guestView.getUint16(0x40, true), 0x2345);
  strictEqual(state.instructionCount, 8);
});

test("executes JMP r/m32 with register target", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x2000,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeControlInstruction([0xff, 0xe0], initialState);

  strictEqual(state.eip, 0x2000);
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.instructionCount, 8);
});

test("executes operand-size JMP r/m16 with a masked register target", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_2000,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeControlInstruction([0x66, 0xff, 0xe0], initialState);

  strictEqual(state.eip, 0x2000);
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.instructionCount, 8);
});

test("executes RET by popping the target into EIP", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeControlInstruction(
    [0xc3],
    initialState,
    (guest) => guest.setUint32(0x40, 0x3000, true)
  );

  strictEqual(state.eip, 0x3000);
  strictEqual(state.esp, 0x44);
  strictEqual(state.instructionCount, 8);
});

test("executes operand-size RET by popping a word target into EIP", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeControlInstruction(
    [0x66, 0xc3],
    initialState,
    (guest) => guest.setUint16(0x40, 0x3000, true)
  );

  strictEqual(state.eip, 0x3000);
  strictEqual(state.esp, 0x42);
  strictEqual(state.instructionCount, 8);
});

test("executes RET imm16 by popping the target then adding stack bytes", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeControlInstruction(
    [0xc2, 0x08, 0x00],
    initialState,
    (guest) => guest.setUint32(0x40, 0x3000, true)
  );

  strictEqual(state.eip, 0x3000);
  strictEqual(state.esp, 0x4c);
  strictEqual(state.instructionCount, 8);
});

test("executes operand-size RET imm16 by popping a word target then adding stack bytes", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeControlInstruction(
    [0x66, 0xc2, 0x08, 0x00],
    initialState,
    (guest) => guest.setUint16(0x40, 0x3000, true)
  );

  strictEqual(state.eip, 0x3000);
  strictEqual(state.esp, 0x4a);
  strictEqual(state.instructionCount, 8);
});
