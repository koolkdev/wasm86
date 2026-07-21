import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  assertLazyFlagState,
  createWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf
} from "#test/support/cpu-state.js";
import { writePageFaultStop } from "#cpu/tests/stop-fixtures.js";
import { invalidOpcode } from "#core/exceptions.js";
import { startAddress } from "#test/support/addresses.js";
import {
  assertInterpreterStateEquals,
  assertCompletedInstruction,
  assertSingleInstructionExit,
  executeInstruction,
  instantiateInterpreter,
  writeInterpreterState,
  writeGuestBytes
} from "./harness.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;
const mixedFlags = { CF: 1, PF: 0, AF: 1, ZF: 0, SF: 1, OF: 1 } as const;

test("executes CMPXCHG register success and failure paths", async () => {
  const success = await executeInstruction(
    [0x0f, 0xb1, 0xd9],
    createWasmCpuStateSnapshot({
      eax: 5,
      ebx: 9,
      ecx: 5,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const failure = await executeInstruction(
    [0x0f, 0xb1, 0xd9],
    createWasmCpuStateSnapshot({
      eax: 7,
      ebx: 9,
      ecx: 5,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(success.exit);
  strictEqual(success.state.eax, 5);
  strictEqual(success.state.ebx, 9);
  strictEqual(success.state.ecx, 9);
  assertCompletedInstruction(success.state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(success.state), allFlagsSet);
  assertLazyFlagState(success.state, { kind: "SUB", width: 32, a: 5, b: 5 });

  assertSingleInstructionExit(failure.exit);
  strictEqual(failure.state.eax, 5);
  strictEqual(failure.state.ebx, 9);
  strictEqual(failure.state.ecx, 5);
  assertCompletedInstruction(failure.state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(failure.state), allFlagsSet);
  assertLazyFlagState(failure.state, { kind: "SUB", width: 32, a: 7, b: 5 });
});

test("CMPXCHG accumulator destination keeps the source value on success", async () => {
  const { exit, state } = await executeInstruction(
    [0x0f, 0xb1, 0xd8],
    createWasmCpuStateSnapshot({
      eax: 5,
      ebx: 9,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 9);
  strictEqual(state.ebx, 9);
  assertCompletedInstruction(state, startAddress + 3, 8);
  assertLazyFlagState(state, { kind: "SUB", width: 32, a: 5, b: 5 });
});

test("executes CMPXCHG memory success and failure paths", async () => {
  const success = await executeInstruction(
    [0x0f, 0xb1, 0x1d, 0x20, 0x00, 0x00, 0x00],
    createWasmCpuStateSnapshot({
      eax: 5,
      ebx: 0x1122_3344,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    }),
    [{ address: 0x20, bytes: dwordBytes(5) }]
  );
  const failure = await executeInstruction(
    [0x0f, 0xb1, 0x1d, 0x24, 0x00, 0x00, 0x00],
    createWasmCpuStateSnapshot({
      eax: 7,
      ebx: 0x5566_7788,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    }),
    [{ address: 0x24, bytes: dwordBytes(5) }]
  );

  assertSingleInstructionExit(success.exit);
  strictEqual(success.guestView.getUint32(0x20, true), 0x1122_3344);
  strictEqual(success.state.eax, 5);
  assertLazyFlagState(success.state, { kind: "SUB", width: 32, a: 5, b: 5 });

  assertSingleInstructionExit(failure.exit);
  strictEqual(failure.guestView.getUint32(0x24, true), 5);
  strictEqual(failure.state.eax, 5);
  assertLazyFlagState(failure.state, { kind: "SUB", width: 32, a: 7, b: 5 });
});

test("executes XADD register and same-register forms", async () => {
  const normal = await executeInstruction(
    [0x0f, 0xc1, 0xd8],
    createWasmCpuStateSnapshot({
      eax: 5,
      ebx: 7,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const same = await executeInstruction(
    [0x0f, 0xc1, 0xc0],
    createWasmCpuStateSnapshot({
      eax: 0x8000_0000,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(normal.exit);
  strictEqual(normal.state.eax, 12);
  strictEqual(normal.state.ebx, 5);
  assertLazyFlagState(normal.state, { kind: "ADD", width: 32, a: 5, b: 7 });

  assertSingleInstructionExit(same.exit);
  strictEqual(same.state.eax, 0);
  assertLazyFlagState(same.state, { kind: "ADD", width: 32, a: 0x8000_0000, b: 0x8000_0000 });
});

test("executes XADD memory form", async () => {
  const { exit, state, guestView } = await executeInstruction(
    [0x0f, 0xc1, 0x1d, 0x20, 0x00, 0x00, 0x00],
    createWasmCpuStateSnapshot({
      ebx: 7,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    }),
    [{ address: 0x20, bytes: dwordBytes(5) }]
  );

  assertSingleInstructionExit(exit);
  strictEqual(guestView.getUint32(0x20, true), 12);
  strictEqual(state.ebx, 5);
  assertLazyFlagState(state, { kind: "ADD", width: 32, a: 5, b: 7 });
});

test("executes CMPXCHG8B success and failure paths", async () => {
  const success = await executeInstruction(
    [0x0f, 0xc7, 0x0d, 0x20, 0x00, 0x00, 0x00],
    createWasmCpuStateSnapshot({
      eax: 0x1111_1111,
      edx: 0x2222_2222,
      ebx: 0x3333_3333,
      ecx: 0x4444_4444,
      ...mixedFlags,
      eip: startAddress,
      instructionCount: 7
    }),
    [{ address: 0x20, bytes: [...dwordBytes(0x1111_1111), ...dwordBytes(0x2222_2222)] }]
  );
  const failure = await executeInstruction(
    [0x0f, 0xc7, 0x0d, 0x28, 0x00, 0x00, 0x00],
    createWasmCpuStateSnapshot({
      eax: 0x9999_9999,
      edx: 0x2222_2222,
      ebx: 0x3333_3333,
      ecx: 0x4444_4444,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    }),
    [{ address: 0x28, bytes: [...dwordBytes(0x1111_1111), ...dwordBytes(0x2222_2222)] }]
  );

  assertSingleInstructionExit(success.exit);
  strictEqual(success.guestView.getUint32(0x20, true), 0x3333_3333);
  strictEqual(success.guestView.getUint32(0x24, true), 0x4444_4444);
  strictEqual(success.state.eax, 0x1111_1111);
  strictEqual(success.state.edx, 0x2222_2222);
  deepStrictEqual(wasmCpuStatusFlagsOf(success.state), { ...mixedFlags, ZF: 1 });
  assertLazyFlagState(success.state, { kind: "NONE", width: 0 });

  assertSingleInstructionExit(failure.exit);
  strictEqual(failure.guestView.getUint32(0x28, true), 0x1111_1111);
  strictEqual(failure.guestView.getUint32(0x2c, true), 0x2222_2222);
  strictEqual(failure.state.eax, 0x1111_1111);
  strictEqual(failure.state.edx, 0x2222_2222);
  deepStrictEqual(wasmCpuStatusFlagsOf(failure.state), { ...allFlagsSet, ZF: 0 });
  assertLazyFlagState(failure.state, { kind: "NONE", width: 0 });
});

test("CMPXCHG memory destination fault leaves architectural state unchanged", async () => {
  const interpreter = await instantiateInterpreter();
  const faultAddress = interpreter.guestView.byteLength - 3;
  const initialState = createWasmCpuStateSnapshot({
    eax: 5,
    ebx: 9,
    ...allFlagsSet,
    eip: startAddress,
    instructionCount: 7
  });

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x0f, 0xb1, 0x1d, ...dwordBytes(faultAddress)]);

  const exit = interpreter.runFor(1);

  deepStrictEqual(exit, writePageFaultStop(faultAddress));
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("LOCK-prefixed compare-exchange opcodes raise #UD", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 5,
    ebx: 9,
    eip: startAddress,
    instructionCount: 7
  });

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0xf0, 0x0f, 0xb1, 0xd8]);

  const exit = interpreter.runFor(1);

  deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

function dwordBytes(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}
