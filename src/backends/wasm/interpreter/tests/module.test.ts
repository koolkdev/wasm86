import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createCpuState } from "#x86/state/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState
} from "./interpreter-helpers.js";
import { assertMemoryImports, startAddress } from "#wasm/tests/helpers.js";
import { wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import {
  extractOnlyWasmFunctionBody,
  wasmBodyOpcodes,
  wasmBodyMemoryAccesses
} from "#wasm/tests/body-opcodes.js";
import { ExitReason } from "#wasm/exit.js";
import { readInterpreterWasmArtifact } from "#backends/wasm/interpreter/artifact.js";
import { encodeInterpreterModule } from "#backends/wasm/interpreter/module.js";
import { instantiateWasmInterpreter, writeGuestBytes } from "./support.js";

test("generated interpreter artifact matches the encoder output", () => {
  const artifact = readInterpreterWasmArtifact();
  const encoded = encodeInterpreterModule();

  strictEqual(artifact.byteLength, encoded.byteLength);
  strictEqual(Buffer.compare(Buffer.from(artifact), Buffer.from(encoded)), 0);
});

test("imports state and guest memories in ABI order", () => {
  const module = new WebAssembly.Module(readInterpreterWasmArtifact());

  assertMemoryImports(module);
});

test("generated interpreter sign-extends MOVSX memory forms explicitly", () => {
  const body = extractOnlyWasmFunctionBody(readInterpreterWasmArtifact());
  const opcodes = wasmBodyOpcodes(body);
  const accesses = wasmBodyMemoryAccesses(body);
  const signedGuestLoads = accesses.filter((access) =>
    access.memoryIndex === wasmMemoryIndex.guest &&
    access.offset === 0 &&
    (access.opcode === wasmOpcode.i32Load8S || access.opcode === wasmOpcode.i32Load16S)
  );

  deepStrictEqual(
    new Set(signedGuestLoads.map((access) => access.opcode)),
    new Set()
  );
  strictEqual(opcodes.includes(wasmOpcode.i32Extend8S), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Extend16S), true);
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
  const initialState = createCpuState({
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
  const initialState = createCpuState({
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
  const initialState = createCpuState({
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

test("truncated two-byte opcode escape returns decode fault", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const lastGuestByte = interpreter.guestView.byteLength - 1;
  const initialState = createCpuState({
    eip: lastGuestByte,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  interpreter.guestView.setUint8(lastGuestByte, 0x0f);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, { exitReason: ExitReason.DECODE_FAULT, payload: interpreter.guestView.byteLength });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("unsupported two-byte opcode path dispatches before unsupported exit", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createCpuState({
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
  const module = new WebAssembly.Module(readInterpreterWasmArtifact());
  const stateMemory = new WebAssembly.Memory({ initial: 1 });

  await WebAssembly.instantiate(module, {
    [wasmImport.moduleName]: {
      [wasmImport.stateMemoryName]: stateMemory
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
