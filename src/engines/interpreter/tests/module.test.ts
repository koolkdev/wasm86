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
import { CompletionExit, HostExit } from "#wasm/exit.js";
import { fetchPageFaultExit } from "#wasm/tests/exit-fixtures.js";
import { encodeInterpreterModule } from "#engines/interpreter/module.js";
import { instantiateWasmInterpreter, writeGuestBytes } from "./support.js";
import { wasmDefinedFunctionCount } from "#compiler/encoder/tests/body-opcodes.js";
import { allHelpers } from "#wasm/helpers/module.js";

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

test("includes lazy flag helpers in the module", () => {
  const encoded = encodeInterpreterModule();

  strictEqual(
    wasmDefinedFunctionCount(encoded.bytes),
    1 + encoded.rmDecodeHelpers.length + allHelpers().length
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

  deepStrictEqual(exit, { family: "completion", reason: CompletionExit.INSTRUCTION_LIMIT, payload: 0 });
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

  strictEqual(exit.family, "host");
  strictEqual(exit.reason, HostExit.UNSUPPORTED);
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

  deepStrictEqual(exit, { family: "completion", reason: CompletionExit.INSTRUCTION_LIMIT, payload: 0 });
  strictEqual(state.eax, 0xffff_1234);
  strictEqual(state.eip, startAddress + 4);
  strictEqual(state.instructionCount, 8);
});

test("repeated operand-size prefixes execute with the override operand size", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_0000,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x66, 0x66, 0xb8, 0x34, 0x12]);

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  deepStrictEqual(exit, { family: "completion", reason: CompletionExit.INSTRUCTION_LIMIT, payload: 0 });
  strictEqual(state.eax, 0xffff_1234);
  strictEqual(state.eip, startAddress + 5);
  strictEqual(state.instructionCount, 8);
});

test("unsupported prefix streams report unsupported instead of misdecoding", async () => {
  const interpreter = await instantiateWasmInterpreter();
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

    const exit = interpreter.run(1);

    strictEqual(exit.family, "host");
    strictEqual(exit.reason, HostExit.UNSUPPORTED);
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
  const expected = fetchPageFaultExit(interpreter.guestView.byteLength);

  deepStrictEqual(exit, expected);
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("unsupported two-byte opcode path dispatches before unsupported exit", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x0f, 0x0b]);

  const exit = interpreter.run(1);

  strictEqual(exit.family, "host");
  strictEqual(exit.reason, HostExit.UNSUPPORTED);
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
