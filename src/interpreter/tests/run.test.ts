import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { startAddress } from "#test/support/addresses.js";
import {
  createWasmCpuStateSnapshot,
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  instantiateInterpreter,
  writeGuestBytes
} from "./harness.js";

test("a zero instruction budget returns the limit without changing state", () => {
  const interpreter = instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    eip: startAddress,
    instructionCount: 7
  });

  writeWasmCpuStateSnapshot(interpreter.stateView, initialState);

  deepStrictEqual(interpreter.runFor(0), { kind: "instructionLimit" });
  deepStrictEqual(
    readWasmCpuStateSnapshot(interpreter.stateView),
    initialState
  );
});

test("the instruction deadline wraps with the u32 instruction count", () => {
  const interpreter = instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 0xffff_fffe
  }));
  writeGuestBytes(interpreter.guestView, startAddress, [
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0xbb, 0x02, 0x00, 0x00, 0x00
  ]);

  deepStrictEqual(interpreter.runFor(2), { kind: "instructionLimit" });
  const state = readWasmCpuStateSnapshot(interpreter.stateView);

  strictEqual(state.eax, 1);
  strictEqual(state.ebx, 2);
  strictEqual(state.eip, startAddress + 10);
  strictEqual(state.instructionCount, 0);
});

test("the run loop continues from a jump while its budget remains", () => {
  const interpreter = instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  }));
  writeGuestBytes(interpreter.guestView, startAddress, [
    0xeb, 0x02,
    0x00, 0x00,
    0xb8, 0x78, 0x56, 0x34, 0x12
  ]);

  deepStrictEqual(interpreter.runFor(2), { kind: "instructionLimit" });
  const state = readWasmCpuStateSnapshot(interpreter.stateView);

  strictEqual(state.eax, 0x1234_5678);
  strictEqual(state.eip, startAddress + 9);
  strictEqual(state.instructionCount, 9);
});
