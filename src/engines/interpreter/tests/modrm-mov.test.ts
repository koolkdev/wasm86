import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { fetchPageFaultExit, readPageFaultExit } from "#wasm/tests/exit-fixtures.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";

test("executes MOV r32, r/m32 with register ModRM", async () => {
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
  assertCompletedInstruction(state, startAddress + 2, 8);
});

test("executes MOV r/m32, r32 with register ModRM", async () => {
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
  assertCompletedInstruction(state, startAddress + 2, 8);
});

test("memory ModRM with out-of-range address returns read fault without changing architectural state", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xaaaa_aaaa,
    ebx: 0x1234_5678,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x8b, 0x03]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, readPageFaultExit(initialState.ebx));
  assertInterpreterStateEquals(interpreter.stateView, initialState);
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

  deepStrictEqual(exit, fetchPageFaultExit(eip + 1));
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
