import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import {
  assertInterpreterStateEquals,
  assertCompletedInstruction,
  assertSingleInstructionExit,
  instantiateInterpreter,
  readInterpreterState,
  writeInterpreterState,
  writeGuestBytes
} from "./harness.js";
import { startAddress } from "#test/support/addresses.js";
import { fetchPageFaultStop } from "#cpu/tests/stop-fixtures.js";


test("continues the interpreter loop after JMP while the instruction budget remains", async () => {
  const interpreter = await instantiateInterpreter();
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

  const exit = interpreter.runFor(2);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_5678);
  assertCompletedInstruction(state, startAddress + 9, 9);
});

test("truncated JMP rel32 raises instruction-fetch #PF without changing architectural state", async () => {
  const interpreter = await instantiateInterpreter();
  const eip = interpreter.guestView.byteLength - 4;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    eip,
    ZF: 1,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, eip, [0xe9, 0x01, 0x02, 0x03]);

  const exit = interpreter.runFor(1);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 4));
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
