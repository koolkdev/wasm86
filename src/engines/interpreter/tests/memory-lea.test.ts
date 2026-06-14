import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { flagsOf,
  createCpuState, type CpuState } from "#x86/state/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { ExitReason, type DecodedExit } from "#wasm/exit.js";
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
  state: CpuState;
}>;

async function executeMemoryInstruction(
  bytes: readonly number[],
  initialState: CpuState,
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

test("executes MOV r32, [base + disp8]", async () => {
  const initialState = createCpuState({
    ebx: 0x20,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeMemoryInstruction(
    [0x8b, 0x43, 0x04],
    initialState,
    (guest) => guest.setUint32(0x24, 0x89ab_cdef, true)
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x89ab_cdef);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 3, 8);
});

test("executes MOV [base + disp8], r32", async () => {
  const initialState = createCpuState({
    eax: 0x1234_5678,
    ebx: 0x20,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, exit, state } = await executeMemoryInstruction([0x89, 0x43, 0x04], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(interpreter.guestView.getUint32(0x24, true), 0x1234_5678);
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 3, 8);
});

test("executes MOV [base + disp8], imm32 through C7 group", async () => {
  const initialState = createCpuState({
    ebx: 0x20,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, exit, state } = await executeMemoryInstruction(
    [0xc7, 0x43, 0x04, 0x78, 0x56, 0x34, 0x12],
    initialState
  );

  assertSingleInstructionExit(exit);
  strictEqual(interpreter.guestView.getUint32(0x24, true), 0x1234_5678);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 7, 8);
});

test("executes LEA r32, [base + index*scale + disp8] without reading memory", async () => {
  const initialState = createCpuState({
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
  const initialState = createCpuState({
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
  deepStrictEqual(flagsOf(state), flagsOf(initialState));
  strictEqual(state.ebx, initialState.ebx);
  strictEqual(state.esi, initialState.esi);
  assertCompletedInstruction(state, startAddress + 5, 8);
});

test("executes MOV r32, [disp32]", async () => {
  const initialState = createCpuState({
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeMemoryInstruction(
    [0x8b, 0x05, 0x20, 0x00, 0x00, 0x00],
    initialState,
    (guest) => guest.setUint32(0x20, 0xc001_cafe, true)
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xc001_cafe);
  assertCompletedInstruction(state, startAddress + 6, 8);
});

test("memory read guards report 1, 2, and 4 byte fault ranges", async () => {
  for (const width of [8, 16, 32] as const) {
    const faultAddress = 0x1_0000 - width / 8 + 1;
    const initialState = createCpuState({
      eax: 0xaaaa_aaaa,
      eip: startAddress,
      instructionCount: 7
    });

    const { interpreter, exit } = await executeMemoryInstruction(
      movReadDisp32Bytes(width, faultAddress),
      initialState
    );

    deepStrictEqual(exit, {
      exitReason: ExitReason.MEMORY_READ_FAULT,
      payload: faultAddress,
      detail: width / 8
    });
    assertInterpreterStateEquals(interpreter.stateView, initialState);
  }
});

test("memory write guards report 1, 2, and 4 byte fault ranges before stores", async () => {
  for (const width of [8, 16, 32] as const) {
    const faultAddress = 0x1_0000 - width / 8 + 1;
    const initialState = createCpuState({
      eax: 0x1234_5678,
      eip: startAddress,
      instructionCount: 7
    });

    const { interpreter, exit } = await executeMemoryInstruction(
      movWriteDisp32Bytes(width, faultAddress),
      initialState
    );

    deepStrictEqual(exit, {
      exitReason: ExitReason.MEMORY_WRITE_FAULT,
      payload: faultAddress,
      detail: width / 8
    });
    assertInterpreterStateEquals(interpreter.stateView, initialState);
  }
});

test("executes MOV r32, [index*scale + disp32] through SIB", async () => {
  const initialState = createCpuState({
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
  assertCompletedInstruction(state, startAddress + 7, 8);
});

test("LEA m32 form rejects register ModRM", async () => {
  const initialState = createCpuState({
    eax: 0x1234_5678,
    eip: startAddress,
    instructionCount: 7
  });
  const { interpreter, exit } = await executeMemoryInstruction([0x8d, 0xc0], initialState);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

function movReadDisp32Bytes(width: 8 | 16 | 32, address: number): readonly number[] {
  switch (width) {
    case 8:
      return [0x8a, 0x05, ...disp32(address)];
    case 16:
      return [0x66, 0x8b, 0x05, ...disp32(address)];
    case 32:
      return [0x8b, 0x05, ...disp32(address)];
  }
}

function movWriteDisp32Bytes(width: 8 | 16 | 32, address: number): readonly number[] {
  switch (width) {
    case 8:
      return [0x88, 0x05, ...disp32(address)];
    case 16:
      return [0x66, 0x89, 0x05, ...disp32(address)];
    case 32:
      return [0x89, 0x05, ...disp32(address)];
  }
}

function disp32(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}
