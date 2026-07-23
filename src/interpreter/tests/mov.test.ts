import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import {
  assertInterpreterStateEquals,
  assertSingleInstructionExit,
  instantiateInterpreter,
  readInterpreterState,
  writeInterpreterState,
  writeGuestBytes
} from "./harness.js";
import { startAddress } from "#test/support/addresses.js";

test("interpreter binds MOV opcode low bits to EDI", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0xbf, 0x01, 0x00, 0x00, 0x00]);

  const exit = interpreter.runFor(1);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.edi, 1);
  strictEqual(state.eax, initialState.eax);
});

test("interpreter dispatches the C7 /0 register form", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0xc7, 0xc0, 0x78, 0x56, 0x34, 0x12]);

  const exit = interpreter.runFor(1);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_5678);
});

test("truncated moffs32 raises instruction-fetch #PF at the first unavailable byte", async () => {
  const interpreter = await instantiateInterpreter();
  const eip = interpreter.guestView.byteLength - 4;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    eip,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, eip, [0xa1, 0x20, 0x00, 0x00]);

  const exit = interpreter.runFor(1);

  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: {
      kind: "PF",
      linearAddress: eip + 4,
      errorCode: 16
    }
  });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("truncated MOV r32, imm32 raises instruction-fetch #PF without changing architectural state", async () => {
  const interpreter = await instantiateInterpreter();
  const eip = interpreter.guestView.byteLength - 3;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    eip,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, eip, [0xb8, 0x01, 0x02]);

  const exit = interpreter.runFor(1);

  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: {
      kind: "PF",
      linearAddress: eip + 3,
      errorCode: 16
    }
  });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
