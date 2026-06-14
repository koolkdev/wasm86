import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState
} from "./interpreter-helpers.js";
import { assertMemoryImports, startAddress } from "#wasm/tests/helpers.js";
import { wasmImport } from "#wasm/abi.js";
import { ExitReason } from "#wasm/exit.js";
import { encodeInterpreterModule } from "#engines/interpreter/module.js";
import { instantiateWasmInterpreter, writeGuestBytes } from "./support.js";

test("imports cpu state and guest memories in ABI order", () => {
  const module = new WebAssembly.Module(encodeInterpreterModule().bytes);

  assertMemoryImports(module);
});

test("exports run(fuel) -> i64", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const exportedRun = interpreter.instance.exports.run;

  strictEqual(typeof exportedRun, "function");
  strictEqual(
    WebAssembly.Module.exports(interpreter.module).some((entry) => entry.kind === "function" && entry.name === "run"),
    true
  );
});

test("fuel zero returns instruction-limit exit without changing architectural state", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    ebx: 0x5566_7788,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);

  const exit = interpreter.run(0);

  deepStrictEqual(exit, { exitReason: ExitReason.INSTRUCTION_LIMIT, payload: 0 });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("unsupported byte returns unsupported exit without changing architectural state", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    ebx: 0x5566_7788,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  interpreter.guestView.setUint8(startAddress, 0x62);

  const exit = interpreter.run(1);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("operand-size prefix dispatches to the prefixed opcode form", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_0000,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x66, 0xb8, 0x34, 0x12]);

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  deepStrictEqual(exit, { exitReason: ExitReason.INSTRUCTION_LIMIT, payload: 0 });
  strictEqual(state.eax, 0xffff_1234);
  strictEqual(state.eip, startAddress + 4);
  strictEqual(state.instructionCount, 8);
});

test("non-canonical prefix encodings report unsupported instead of misdecoding", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const cases = [
    [0x66, 0x66, 0xb8, 0x34, 0x12], // repeated operand-size prefix
    [0x66, 0x0f, 0x84, 0x00, 0x00, 0x00, 0x00] // prefix on an unprefixed-only form
  ] as const;

  for (const bytes of cases) {
    const initialState = createWasmCpuStateSnapshot({
      eax: 0x1122_3344,
      eip: startAddress,
      instructionCount: 7
    });
    writeInterpreterState(interpreter.stateView, initialState);
    writeGuestBytes(interpreter.guestView, startAddress, bytes);

    const exit = interpreter.run(1);

    strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
    assertInterpreterStateEquals(interpreter.stateView, initialState);
  }
});

test("truncated two-byte opcode escape returns decode fault", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const lastGuestByte = interpreter.guestView.byteLength - 1;
  const initialState = createWasmCpuStateSnapshot({
    eip: lastGuestByte,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  interpreter.guestView.setUint8(lastGuestByte, 0x0f);

  const exit = interpreter.run(1);

  strictEqual(exit.exitReason, ExitReason.DECODE_FAULT);
  strictEqual(exit.payload, interpreter.guestView.byteLength);
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("unsupported two-byte opcode path dispatches before unsupported exit", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x0f, 0xa0]);

  const exit = interpreter.run(1);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("requires both ABI memories when instantiating", async () => {
  const module = new WebAssembly.Module(encodeInterpreterModule().bytes);
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
