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
import { assertMemoryImports } from "#wasm/tests/helpers.js";
import { wasmImport } from "#wasm/abi.js";
import { fetchPageFaultStop } from "#cpu/tests/stop-fixtures.js";
import { invalidOpcode } from "#core/exceptions.js";
import { encodeInterpreterModule } from "#interpreter/module.js";

test("imports cpu state and guest memories in ABI order", () => {
  const module = new WebAssembly.Module(encodeInterpreterModule());

  assertMemoryImports(module);
});

test("exports parameterless run() -> i64", async () => {
  const interpreter = await instantiateInterpreter();
  const exportedRun = interpreter.instance.exports.run;

  if (typeof exportedRun !== "function") {
    throw new Error("missing exported interpreter run function");
  }
  strictEqual(exportedRun.length, 0);
  strictEqual(
    WebAssembly.Module.exports(interpreter.module).some((entry) => entry.kind === "function" && entry.name === "run"),
    true
  );
});

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

  deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
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

    deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
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
  const expected = fetchPageFaultStop(interpreter.guestView.byteLength);

  deepStrictEqual(exit, expected);
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

  deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("requires both ABI memories when instantiating", async () => {
  const module = new WebAssembly.Module(encodeInterpreterModule());
  const cpuStateMemory = new WebAssembly.Memory({ initial: 1 });

  await WebAssembly.instantiate(module, {
    [wasmImport.namespace]: {
      [wasmImport.cpuStateMemoryName]: cpuStateMemory
    }
  }).then(
    () => {
      throw new Error("expected instantiation failure");
    },
    (error: unknown) => {
      strictEqual(error instanceof WebAssembly.LinkError, true);
    }
  );
});
