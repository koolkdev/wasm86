import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot, type WasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { ExitReason } from "#wasm/exit.js";
import type { X86Flag } from "#x86/flags.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";

type StackRunResult = Readonly<{
  interpreter: InterpreterModuleInstance;
  state: WasmCpuStateSnapshot;
}>;

const pushfdFlagMasks = {
  CF: 1 << 0,
  PF: 1 << 2,
  AF: 1 << 4,
  ZF: 1 << 6,
  SF: 1 << 7,
  TF: 1 << 8,
  DF: 1 << 10,
  OF: 1 << 11,
  NT: 1 << 14,
  AC: 1 << 18,
  ID: 1 << 21
} as const satisfies Readonly<Record<X86Flag, number>>;

const allPushfdFlagsSet = Object.fromEntries(
  Object.keys(pushfdFlagMasks).map((flag) => [flag, 1])
) as Readonly<Record<X86Flag, number>>;

async function executeStackInstruction(
  bytes: readonly number[],
  initialState: WasmCpuStateSnapshot,
  setupGuest?: (view: DataView) => void
): Promise<StackRunResult> {
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, bytes);
  setupGuest?.(interpreter.guestView);

  const exit = interpreter.run(1);

  assertSingleInstructionExit(exit);
  return {
    interpreter,
    state: readInterpreterState(interpreter.stateView)
  };
}

test("executes PUSH r32 by decrementing ESP and storing the value", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction([0x50], initialState);

  strictEqual(state.eax, initialState.eax);
  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint32(0x3c, true), 0x1122_3344);
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes PUSH sign-extended imm8", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction([0x6a, 0xff], initialState);

  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint32(0x3c, true), 0xffff_ffff);
  assertCompletedInstruction(state, startAddress + 2, 8);
});

test("executes PUSHFD by storing the usermode eflags image", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    ...allPushfdFlagsSet,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction([0x9c], initialState);

  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint32(0x3c, true), expectedPushfdImage(allPushfdFlagsSet));
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes PUSHFD with the fixed usermode image when no state flags are set", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction([0x9c], initialState);

  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint32(0x3c, true), 0x202);
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("a faulting PUSHFD write reports its eip with prior state flushed", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_ffff,
    esp: 2,
    eip: startAddress,
    instructionCount: 7
  });
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x83, 0xc0, 0x01, 0x9c]);

  const exit = interpreter.run(2);
  const state = readInterpreterState(interpreter.stateView);

  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_WRITE_FAULT, payload: 0xffff_fffe, detail: 4 });
  strictEqual(state.eax, 0);
  strictEqual(state.esp, 2);
  strictEqual(state.eip, startAddress + 3);
  strictEqual(state.instructionCount, 8);
  deepStrictEqual(
    { CF: state.CF, PF: state.PF, AF: state.AF, ZF: state.ZF, SF: state.SF, OF: state.OF },
    { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 0, OF: 0 }
  );
});

test("executes POP r32 by loading from ESP then incrementing ESP", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeStackInstruction(
    [0x58],
    initialState,
    (guest) => guest.setUint32(0x40, 0x5566_7788, true)
  );

  strictEqual(state.eax, 0x5566_7788);
  strictEqual(state.esp, 0x44);
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes POP ESP with popped value as final ESP", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeStackInstruction(
    [0x5c],
    initialState,
    (guest) => guest.setUint32(0x40, 0x80, true)
  );

  strictEqual(state.esp, 0x80);
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes LEAVE by restoring EBP and ESP from the frame", async () => {
  const initialState = createWasmCpuStateSnapshot({
    ebp: 0x40,
    esp: 0x20,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeStackInstruction(
    [0xc9],
    initialState,
    (guest) => guest.setUint32(0x40, 0x5566_7788, true)
  );

  strictEqual(state.ebp, 0x5566_7788);
  strictEqual(state.esp, 0x44);
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes POP [ESP] by writing at the incremented ESP", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction(
    [0x8f, 0x04, 0x24],
    initialState,
    (guest) => guest.setUint32(0x40, 0x5566_7788, true)
  );

  strictEqual(state.esp, 0x44);
  strictEqual(interpreter.guestView.getUint32(0x44, true), 0x5566_7788);
  assertCompletedInstruction(state, startAddress + 3, 8);
});

function expectedPushfdImage(flags: Partial<Record<X86Flag, number>>): number {
  let image = 0x202;

  for (const flag of Object.keys(pushfdFlagMasks) as X86Flag[]) {
    if (flags[flag] !== undefined && flags[flag] !== 0) {
      image |= pushfdFlagMasks[flag];
    }
  }

  return image >>> 0;
}

test("executes POP [ESP + disp8] against the incremented ESP", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction(
    [0x8f, 0x44, 0x24, 0x08],
    initialState,
    (guest) => guest.setUint32(0x40, 0x5566_7788, true)
  );

  strictEqual(state.esp, 0x44);
  strictEqual(interpreter.guestView.getUint32(0x4c, true), 0x5566_7788);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("a faulting POP [mem] write leaves ESP, EIP, and the stack untouched", async () => {
  const initialState = createWasmCpuStateSnapshot({
    ebx: 0xfffd,
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, [0x8f, 0x03]);
  interpreter.guestView.setUint32(0x40, 0x5566_7788, true);

  const exit = interpreter.run(1);

  // The destination write guard faults after the handler already advanced
  // esp on the main path; the fault edge must restore it.
  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_WRITE_FAULT, payload: 0xfffd, detail: 4 });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
  strictEqual(interpreter.guestView.getUint32(0x40, true), 0x5566_7788);
});

test("executes PUSH [ESP] by reading the source before writing the new stack slot", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction(
    [0xff, 0x34, 0x24],
    initialState,
    (guest) => guest.setUint32(0x40, 0xaabb_ccdd, true)
  );

  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint32(0x3c, true), 0xaabb_ccdd);
  strictEqual(interpreter.guestView.getUint32(0x40, true), 0xaabb_ccdd);
  assertCompletedInstruction(state, startAddress + 3, 8);
});
