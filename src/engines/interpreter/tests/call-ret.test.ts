import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot, type WasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import {
  readInterpreterState,
  writeInterpreterState,
  assertInterpreterStateEquals,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
import {
  assertSingleInstructionExit,
  executeProgram,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";
import { readPageFaultExit, writePageFaultExit } from "#wasm/tests/exit-fixtures.js";
import { HostExit } from "#wasm/exit.js";

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

test("executes ENTER level 0 by pushing EBP and allocating stack bytes", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x80,
    ebp: 0x1234_5678,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeControlInstruction(
    [0xc8, 0x10, 0x00, 0x00],
    initialState
  );

  strictEqual(state.ebp, 0x7c);
  strictEqual(state.esp, 0x6c);
  strictEqual(interpreter.guestView.getUint32(0x7c, true), initialState.ebp);
  strictEqual(state.eip, startAddress + 4);
  strictEqual(state.instructionCount, 8);
});

test("executes ENTER level 2 by copying the enclosing display", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x120,
    ebp: 0x180,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeControlInstruction(
    [0xc8, 0x04, 0x00, 0x02],
    initialState,
    (guest) => guest.setUint32(0x17c, 0xaaaa_0001, true)
  );

  strictEqual(state.ebp, 0x11c);
  strictEqual(state.esp, 0x110);
  strictEqual(interpreter.guestView.getUint32(0x11c, true), 0x180);
  strictEqual(interpreter.guestView.getUint32(0x118, true), 0xaaaa_0001);
  strictEqual(interpreter.guestView.getUint32(0x114, true), 0x11c);
  strictEqual(state.eip, startAddress + 4);
  strictEqual(state.instructionCount, 8);
});

test("executes ENTER level 31 by copying every display slot", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x300,
    ebp: 0x500,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeControlInstruction(
    [0xc8, 0x00, 0x00, 0x1f],
    initialState,
    (guest) => {
      for (let index = 0; index < 30; index += 1) {
        guest.setUint32(0x4fc - index * 4, 0x9000 + index, true);
      }
    }
  );

  strictEqual(state.ebp, 0x2fc);
  strictEqual(state.esp, 0x280);
  strictEqual(interpreter.guestView.getUint32(0x2fc, true), 0x500);
  for (let index = 0; index < 30; index += 1) {
    strictEqual(interpreter.guestView.getUint32(0x2f8 - index * 4, true), 0x9000 + index);
  }
  strictEqual(interpreter.guestView.getUint32(0x280, true), 0x2fc);
  strictEqual(state.eip, startAddress + 4);
  strictEqual(state.instructionCount, 8);
});

test("ENTER masks the nesting level to five bits", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x80,
    ebp: 0x200,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeControlInstruction(
    [0xc8, 0x04, 0x00, 0x21],
    initialState
  );

  strictEqual(state.ebp, 0x7c);
  strictEqual(state.esp, 0x74);
  strictEqual(interpreter.guestView.getUint32(0x7c, true), 0x200);
  strictEqual(interpreter.guestView.getUint32(0x78, true), 0x7c);
  strictEqual(state.eip, startAddress + 4);
  strictEqual(state.instructionCount, 8);
});

test("nested ENTER level 2 reads an outer local through the display", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x300,
    eip: startAddress
  });
  const program = [
    0xc8, 0x04, 0x00, 0x01,             // enter 4, 1
    0xc7, 0x45, 0xf8, 0x78, 0x56, 0x34, 0x12, // mov dword [ebp-8], 0x12345678
    0xe8, 0x02, 0x00, 0x00, 0x00,       // call inner
    0xcd, 0x2e,                         // int 0x2e
    0xc8, 0x04, 0x00, 0x02,             // inner: enter 4, 2
    0x8b, 0x45, 0xfc,                   // mov eax, [ebp-4]
    0x8b, 0x40, 0xf8,                   // mov eax, [eax-8]
    0xc9,                               // leave
    0xc3                                // ret
  ];

  const { exit, state } = await executeProgram(program, initialState, 20);

  deepStrictEqual(exit, { family: "host", reason: HostExit.TRAP, payload: 0x2e });
  strictEqual(state.eax, 0x1234_5678);
  strictEqual(state.ebp, 0x2fc);
  strictEqual(state.esp, 0x2f4);
  strictEqual(state.eip, startAddress + 18);
  strictEqual(state.instructionCount, 9);
});

test("ENTER write guard fault leaves architectural state unchanged", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const faultAddress = interpreter.guestView.byteLength - 2;
  const initialState = createWasmCpuStateSnapshot({
    esp: interpreter.guestView.byteLength + 2,
    ebp: 0x1234_5678,
    eip: startAddress,
    instructionCount: 7
  });

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0xc8, 0x00, 0x00, 0x00]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, writePageFaultExit(faultAddress));
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("ENTER read guard fault leaves architectural state unchanged", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const faultAddress = interpreter.guestView.byteLength - 2;
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x80,
    ebp: interpreter.guestView.byteLength + 2,
    eip: startAddress,
    instructionCount: 7
  });

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0xc8, 0x00, 0x00, 0x02]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, readPageFaultExit(faultAddress));
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
