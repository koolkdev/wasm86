import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { startAddress } from "#test/support/addresses.js";
import {
  createWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf,
  type WasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { HostExit, type DecodedExit } from "#wasm/exit.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

type MemoryRunResult = Readonly<{
  interpreter: InterpreterModuleInstance;
  exit: DecodedExit;
  state: WasmCpuStateSnapshot;
}>;

async function executeMemoryInstruction(
  bytes: readonly number[],
  initialState: WasmCpuStateSnapshot,
  setupGuest?: (view: DataView) => void
): Promise<MemoryRunResult> {
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, bytes);
  setupGuest?.(interpreter.guestView);

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  return { interpreter, exit, state };
}

test("executes LEA r32, [base + index*scale + disp8] without reading memory", async () => {
  const initialState = createWasmCpuStateSnapshot({
    ebx: 0x100,
    esi: 3,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeMemoryInstruction([0x8d, 0x44, 0xb3, 0x08], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x114);
  strictEqual(state.ebx, initialState.ebx);
  strictEqual(state.esi, initialState.esi);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("executes LEA r16 without reading memory or modifying flags", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_0000,
    ebx: 0x100,
    esi: 3,
    ...allFlagsSet,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeMemoryInstruction([0x66, 0x8d, 0x44, 0xb3, 0x08], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_0114);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), wasmCpuStatusFlagsOf(initialState));
  strictEqual(state.ebx, initialState.ebx);
  strictEqual(state.esi, initialState.esi);
  assertCompletedInstruction(state, startAddress + 5, 8);
});

test("interpreter binds MOV SIB index, scale, and disp32 at runtime", async () => {
  const initialState = createWasmCpuStateSnapshot({
    ecx: 2,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeMemoryInstruction(
    [0x8b, 0x04, 0x8d, 0x20, 0x00, 0x00, 0x00],
    initialState,
    (guest) => guest.setUint32(0x28, 0xfeed_beef, true)
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xfeed_beef);
  strictEqual(state.ecx, initialState.ecx);
});

test("LEA m32 form rejects register ModRM", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    eip: startAddress,
    instructionCount: 7
  });
  const { interpreter, exit } = await executeMemoryInstruction([0x8d, 0xc0], initialState);

  strictEqual(exit.family, "host");
  strictEqual(exit.reason, HostExit.UNSUPPORTED);
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
