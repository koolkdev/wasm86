import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import {
  assertInterpreterStateEquals,
  instantiateInterpreter,
  readInterpreterState,
  writeInterpreterState,
  writeGuestBytes
} from "./harness.js";
import { startAddress } from "#test/support/addresses.js";

test("a zero instruction budget returns the limit exit without changing architectural state", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    ebx: 0x5566_7788,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);

  const exit = interpreter.runFor(0);

  deepStrictEqual(exit, { kind: "instructionLimit" });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("an undefined byte raises #UD without changing architectural state", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    ebx: 0x5566_7788,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  interpreter.guestView.setUint8(startAddress, 0x62);

  const exit = interpreter.runFor(1);

  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: { kind: "UD" }
  });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("operand-size prefix dispatches to the prefixed opcode form", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_0000,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x66, 0xb8, 0x34, 0x12]);

  const exit = interpreter.runFor(1);
  const state = readInterpreterState(interpreter.stateView);

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(state.eax, 0xffff_1234);
  strictEqual(state.eip, startAddress + 4);
  strictEqual(state.instructionCount, 8);
});

test("repeated operand-size prefixes execute with the override operand size", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_0000,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x66, 0x66, 0xb8, 0x34, 0x12]);

  const exit = interpreter.runFor(1);
  const state = readInterpreterState(interpreter.stateView);

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(state.eax, 0xffff_1234);
  strictEqual(state.eip, startAddress + 5);
  strictEqual(state.instructionCount, 8);
});

test("the absolute instruction deadline wraps with the u32 instruction count", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 0xffff_fffe
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0xbb, 0x02, 0x00, 0x00, 0x00
  ]);

  const exit = interpreter.runFor(2);
  const state = readInterpreterState(interpreter.stateView);

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(state.eax, 1);
  strictEqual(state.ebx, 2);
  strictEqual(state.eip, startAddress + 10);
  strictEqual(state.instructionCount, 0);
});

test("undefined prefix streams raise #UD instead of misdecoding", async () => {
  const interpreter = await instantiateInterpreter();
  const cases = [
    [0x67, 0xb8, 0x34, 0x12, 0x00, 0x00], // address-size prefix
    [0x66, 0xf3, 0xb8, 0x34, 0x12] // REP on a non-REP opcode
  ] as const;

  for (const bytes of cases) {
    const initialState = createWasmCpuStateSnapshot({
      eax: 0x1122_3344,
      eip: startAddress,
      instructionCount: 7
    });
    writeInterpreterState(interpreter.stateView, initialState);
    writeGuestBytes(interpreter.guestView, startAddress, bytes);

    const exit = interpreter.runFor(1);

    deepStrictEqual(exit, {
      kind: "cpuException",
      exception: { kind: "UD" }
    });
    assertInterpreterStateEquals(interpreter.stateView, initialState);
  }
});

test("a truncated two-byte opcode escape raises instruction-fetch #PF", async () => {
  const interpreter = await instantiateInterpreter();
  const lastGuestByte = interpreter.guestView.byteLength - 1;
  const initialState = createWasmCpuStateSnapshot({
    eip: lastGuestByte,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  interpreter.guestView.setUint8(lastGuestByte, 0x0f);

  const exit = interpreter.runFor(1);
  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: {
      kind: "PF",
      linearAddress: interpreter.guestView.byteLength,
      errorCode: 16
    }
  });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("undefined two-byte opcode path raises #UD after consuming the escape", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x0f, 0x0b]);

  const exit = interpreter.runFor(1);

  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: { kind: "UD" }
  });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("the Interpreter rejects undefined F7 /1 before demanding its address bytes", async () => {
  const interpreter = await instantiateInterpreter();
  const eip = interpreter.guestView.byteLength - 2;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    eip,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, eip, [0xf7, 0x0d]);

  const exit = interpreter.runFor(1);

  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: { kind: "UD" }
  });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
