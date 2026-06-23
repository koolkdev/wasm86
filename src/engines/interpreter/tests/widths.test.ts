import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ExitReason } from "#wasm/exit.js";
import { startAddress } from "#wasm/tests/helpers.js";
import {
  createWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf,
  type WasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  executeInstruction,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

const addWraparoundFlags = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 0, OF: 0 } as const;
const subBorrowFlags = { CF: 1, PF: 1, AF: 1, ZF: 0, SF: 1, OF: 0 } as const;
const zeroResultFlags = { CF: 0, PF: 1, AF: 0, ZF: 1, SF: 0, OF: 0 } as const;
const signLogicFlags = { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 1, OF: 0 } as const;

test("executes MOV into AL, AH, and prefixed AX register views", async () => {
  const movAl = await executeInstruction([0xb0, 0x44], createWasmCpuStateSnapshot({
    eax: 0x1122_3300,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(movAl.exit);
  strictEqual(movAl.state.eax, 0x1122_3344);
  assertCompletedInstruction(movAl.state, startAddress + 2, 8);

  const movAh = await executeInstruction([0xb4, 0x55], createWasmCpuStateSnapshot({
    eax: 0x1122_0033,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(movAh.exit);
  strictEqual(movAh.state.eax, 0x1122_5533);
  assertCompletedInstruction(movAh.state, startAddress + 2, 8);

  const movAx = await executeInstruction([0x66, 0xb8, 0x78, 0x56], createWasmCpuStateSnapshot({
    eax: 0x1234_0000,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(movAx.exit);
  strictEqual(movAx.state.eax, 0x1234_5678);
  assertCompletedInstruction(movAx.state, startAddress + 4, 8);
});

test("executes byte and word memory reads and writes", async () => {
  const byteStore = await executeWithGuest([0x88, 0x03], createWasmCpuStateSnapshot({
    eax: 0xaabb_ccdd,
    ebx: 0x40,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(byteStore.exit);
  strictEqual(byteStore.interpreter.guestView.getUint8(0x40), 0xdd);
  assertCompletedInstruction(byteStore.state, startAddress + 2, 8);

  const wordLoad = await executeWithGuest(
    [0x66, 0x8b, 0x03],
    createWasmCpuStateSnapshot({
      eax: 0xffff_0000,
      ebx: 0x40,
      eip: startAddress,
      instructionCount: 7
    }),
    (guest) => guest.setUint16(0x40, 0x1234, true)
  );

  assertSingleInstructionExit(wordLoad.exit);
  strictEqual(wordLoad.state.eax, 0xffff_1234);
  assertCompletedInstruction(wordLoad.state, startAddress + 3, 8);

  const wordStore = await executeWithGuest([0x66, 0x89, 0x03], createWasmCpuStateSnapshot({
    eax: 0xaaaa_babe,
    ebx: 0x44,
    eip: startAddress,
    instructionCount: 7
  }));

  assertSingleInstructionExit(wordStore.exit);
  strictEqual(wordStore.interpreter.guestView.getUint16(0x44, true), 0xbabe);
  strictEqual(wordStore.interpreter.guestView.getUint8(0x46), 0);
  assertCompletedInstruction(wordStore.state, startAddress + 3, 8);
});

test("materializes representative 8/16-bit ALU flags", async () => {
  const add8 = await executeInstruction([0x04, 0x01], createWasmCpuStateSnapshot({
    eax: 0xffff_ffff,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  }));

  assertSingleInstructionExit(add8.exit);
  strictEqual(add8.state.eax, 0xffff_ff00);
  deepStrictEqual(wasmCpuStatusFlagsOf(add8.state), addWraparoundFlags);

  const sub16 = await executeInstruction([0x66, 0x2d, 0x01, 0x00], createWasmCpuStateSnapshot({
    eax: 0xffff_0000,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  }));

  assertSingleInstructionExit(sub16.exit);
  strictEqual(sub16.state.eax, 0xffff_ffff);
  deepStrictEqual(wasmCpuStatusFlagsOf(sub16.state), subBorrowFlags);

  const cmp8 = await executeInstruction([0x3c, 0x80], createWasmCpuStateSnapshot({
    eax: 0x80,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  }));

  assertSingleInstructionExit(cmp8.exit);
  strictEqual(cmp8.state.eax, 0x80);
  deepStrictEqual(wasmCpuStatusFlagsOf(cmp8.state), zeroResultFlags);

  const test16 = await executeInstruction([0x66, 0xa9, 0x00, 0x80], createWasmCpuStateSnapshot({
    eax: 0x8000,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  }));

  assertSingleInstructionExit(test16.exit);
  strictEqual(test16.state.eax, 0x8000);
  deepStrictEqual(wasmCpuStatusFlagsOf(test16.state), signLogicFlags);
});

test("unsupported prefixed opcode streams terminate without changing architectural state", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    eip: startAddress,
    instructionCount: 7
  });

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x66, 0x66, 0x62]);

  const exit = interpreter.run(1);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

async function executeWithGuest(
  bytes: readonly number[],
  initialState: WasmCpuStateSnapshot,
  setupGuest?: (view: DataView) => void
): Promise<Readonly<{
  exit: ReturnType<InterpreterModuleInstance["run"]>;
  interpreter: InterpreterModuleInstance;
  state: WasmCpuStateSnapshot;
}>> {
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, bytes);
  setupGuest?.(interpreter.guestView);

  const exit = interpreter.run(1);

  return {
    exit,
    interpreter,
    state: readInterpreterState(interpreter.stateView)
  };
}
