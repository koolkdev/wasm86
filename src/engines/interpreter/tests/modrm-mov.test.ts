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
  assertSingleInstructionExit,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";

test("interpreter binds MOV 8B ModRM.reg as the destination", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    ebx: 0x1234_5678,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x8b, 0xc3]);

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_5678);
  strictEqual(state.ebx, initialState.ebx);
});

test("interpreter binds MOV 89 ModRM.rm as the destination", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xaaaa_aaaa,
    ebx: 0x1234_5678,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x89, 0xd8]);

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_5678);
  strictEqual(state.ebx, initialState.ebx);
});

test("truncated ModRM returns decode fault without changing architectural state", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const eip = interpreter.guestView.byteLength - 1;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xaaaa_aaaa,
    ebx: 0x1234_5678,
    eip,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  interpreter.guestView.setUint8(eip, 0x8b);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 1));
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
