import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { assertLazyFlagState, createWasmCpuStateSnapshot, type WasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { ExitReason } from "#wasm/exit.js";
import { x86Flags, type X86Flag } from "#x86/flags.js";
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

test("executes PUSH r16 by decrementing ESP by two and storing a word", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction([0x66, 0x50], initialState);

  strictEqual(state.eax, initialState.eax);
  strictEqual(state.esp, 0x3e);
  strictEqual(interpreter.guestView.getUint16(0x3e, true), 0x3344);
  assertCompletedInstruction(state, startAddress + 2, 8);
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

test("executes operand-size PUSH immediates as word stack cells", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [
    0x66, 0x68, 0x34, 0x12,
    0x66, 0x6a, 0xff
  ]);

  const exit = interpreter.run(2);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.esp, 0x3c);
  strictEqual(interpreter.guestView.getUint16(0x3e, true), 0x1234);
  strictEqual(interpreter.guestView.getUint16(0x3c, true), 0xffff);
  assertCompletedInstruction(state, startAddress + 7, 9);
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

test("executes POPFD by distributing stored flags and ignoring privileged bits", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    ...allPushfdFlagsSet,
    eip: startAddress,
    instructionCount: 7
  });
  const privilegedBits = (1 << 9) | (3 << 12) | (1 << 16) | (1 << 17) | (1 << 19) | (1 << 20);

  const { state } = await executeStackInstruction(
    [0x9d],
    initialState,
    (guest) => guest.setUint32(0x40, privilegedBits, true)
  );

  strictEqual(state.esp, 0x44);
  deepStrictEqual(storedFlagsOf(state), storedFlagsFromImage(0));
  assertCompletedInstruction(state, startAddress + 1, 8);
});

test("executes POPFD/PUSHFD as a stored-flag round trip", async () => {
  const image = expectedPushfdImage({ CF: 1, AF: 1, DF: 1, AC: 1, ID: 1 }) | (1 << 9) | (3 << 12) | (1 << 16);
  const expectedImage = expectedPushfdImage(storedFlagsFromImage(image));
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x9d, 0x9c]);
  interpreter.guestView.setUint32(0x40, image, true);

  const exit = interpreter.run(2);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.esp, 0x40);
  strictEqual(interpreter.guestView.getUint32(0x40, true), expectedImage);
  deepStrictEqual(storedFlagsOf(state), storedFlagsFromImage(image));
  assertCompletedInstruction(state, startAddress + 2, 9);
});

test("executes the AC and ID POPFD toggle detection idiom", async () => {
  for (const [name, bit] of [["AC", pushfdFlagMasks.AC], ["ID", pushfdFlagMasks.ID]] as const) {
    const initialState = createWasmCpuStateSnapshot({
      esp: 0x40,
      eip: startAddress,
      instructionCount: 7
    });
    const interpreter = await instantiateWasmInterpreter();

    writeInterpreterState(interpreter.stateView, initialState);
    writeGuestBytes(interpreter.guestView, startAddress, [
      0x9c,
      0x81, 0x34, 0x24, bit & 0xff, (bit >>> 8) & 0xff, (bit >>> 16) & 0xff, (bit >>> 24) & 0xff,
      0x9d,
      0x9c,
      0x58
    ]);

    const exit = interpreter.run(5);
    const state = readInterpreterState(interpreter.stateView);

    assertSingleInstructionExit(exit);
    strictEqual(state.eax, 0x202 | bit, name);
    strictEqual(state.esp, 0x40, name);
    strictEqual(state[name], 1, name);
  }
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
    { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 }
  );
  assertLazyFlagState(state, { kind: "ADD", width: 32, a: 0xffff_ffff, b: 1 });
});

test("a faulting POPFD read reports its eip with prior state flushed", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_ffff,
    esp: 0xffff_fffe,
    eip: startAddress,
    instructionCount: 7
  });
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x83, 0xc0, 0x01, 0x9d]);

  const exit = interpreter.run(2);
  const state = readInterpreterState(interpreter.stateView);

  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0xffff_fffe, detail: 4 });
  strictEqual(state.eax, 0);
  strictEqual(state.esp, 0xffff_fffe);
  strictEqual(state.eip, startAddress + 3);
  strictEqual(state.instructionCount, 8);
  deepStrictEqual(
    { CF: state.CF, PF: state.PF, AF: state.AF, ZF: state.ZF, SF: state.SF, OF: state.OF },
    { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 }
  );
  assertLazyFlagState(state, { kind: "ADD", width: 32, a: 0xffff_ffff, b: 1 });
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

test("executes POP r16 by loading a word and incrementing ESP by two", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xaaaa_0000,
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeStackInstruction(
    [0x66, 0x58],
    initialState,
    (guest) => guest.setUint16(0x40, 0xbeef, true)
  );

  strictEqual(state.eax, 0xaaaa_beef);
  strictEqual(state.esp, 0x42);
  assertCompletedInstruction(state, startAddress + 2, 8);
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

test("executes POP SP as a low-word write after the stack increment", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { state } = await executeStackInstruction(
    [0x66, 0x5c],
    initialState,
    (guest) => guest.setUint16(0x40, 0x1234, true)
  );

  strictEqual(state.esp, 0x1234);
  assertCompletedInstruction(state, startAddress + 2, 8);
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

test("executes POP word [ESP] by writing at the incremented ESP", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction(
    [0x66, 0x8f, 0x04, 0x24],
    initialState,
    (guest) => guest.setUint16(0x40, 0xbeef, true)
  );

  strictEqual(state.esp, 0x42);
  strictEqual(interpreter.guestView.getUint16(0x42, true), 0xbeef);
  assertCompletedInstruction(state, startAddress + 4, 8);
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

function storedFlagsFromImage(image: number): Readonly<Record<X86Flag, number>> {
  return Object.fromEntries(
    x86Flags.map((flag) => [flag, (image & pushfdFlagMasks[flag]) === 0 ? 0 : 1])
  ) as Readonly<Record<X86Flag, number>>;
}

function storedFlagsOf(state: Pick<WasmCpuStateSnapshot, X86Flag>): Readonly<Record<X86Flag, number>> {
  return Object.fromEntries(
    x86Flags.map((flag) => [flag, state[flag]])
  ) as Readonly<Record<X86Flag, number>>;
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

test("executes POP word [ESP + disp8] against the incremented ESP", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction(
    [0x66, 0x8f, 0x44, 0x24, 0x08],
    initialState,
    (guest) => guest.setUint16(0x40, 0xbeef, true)
  );

  strictEqual(state.esp, 0x42);
  strictEqual(interpreter.guestView.getUint16(0x4a, true), 0xbeef);
  assertCompletedInstruction(state, startAddress + 5, 8);
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

test("a faulting POP word [mem] write leaves ESP, EIP, and the stack untouched", async () => {
  const initialState = createWasmCpuStateSnapshot({
    ebx: 0xffff,
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, [0x66, 0x8f, 0x03]);
  interpreter.guestView.setUint16(0x40, 0xbeef, true);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_WRITE_FAULT, payload: 0xffff, detail: 2 });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
  strictEqual(interpreter.guestView.getUint16(0x40, true), 0xbeef);
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

test("executes PUSH word [ESP] by reading the source before writing the new stack slot", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0x40,
    eip: startAddress,
    instructionCount: 7
  });

  const { interpreter, state } = await executeStackInstruction(
    [0x66, 0xff, 0x34, 0x24],
    initialState,
    (guest) => guest.setUint16(0x40, 0xbeef, true)
  );

  strictEqual(state.esp, 0x3e);
  strictEqual(interpreter.guestView.getUint16(0x3e, true), 0xbeef);
  strictEqual(interpreter.guestView.getUint16(0x40, true), 0xbeef);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("a faulting PUSH r16 write reports a word-sized fault", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234,
    esp: 1,
    eip: startAddress,
    instructionCount: 7
  });
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, [0x66, 0x50]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_WRITE_FAULT, payload: 0xffff_ffff, detail: 2 });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("a faulting POP r16 read reports a word-sized fault", async () => {
  const initialState = createWasmCpuStateSnapshot({
    esp: 0xffff,
    eip: startAddress,
    instructionCount: 7
  });
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, [0x66, 0x58]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0xffff, detail: 2 });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
