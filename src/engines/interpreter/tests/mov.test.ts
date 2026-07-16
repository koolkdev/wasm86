import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot, wasmCpuStatusFlagsOf } from "#test/support/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState
} from "./interpreter-helpers.js";
import { startAddress } from "#test/support/addresses.js";
import { fetchPageFaultStop, readPageFaultStop } from "#cpu/tests/stop-fixtures.js";
import { invalidOpcode } from "#core/exceptions.js";
import {
  assertCompletedInstruction,
  executeInstruction,
  assertSingleInstructionExit,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

const zeroFlag = { CF: 0, PF: 0, AF: 0, ZF: 1, SF: 0, OF: 0 } as const;
const noFlags = { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;

test("interpreter binds MOV opcode low bits to EDI", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0xbf, 0x01, 0x00, 0x00, 0x00]);

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.edi, 1);
  strictEqual(state.eax, initialState.eax);
});

test("executes MOV from segment selectors", async () => {
  const wordDestination = await executeInstruction(
    [0x66, 0x8c, 0xe0],
    createWasmCpuStateSnapshot({
      eax: 0xffff_0000,
      fsSelector: 0x1234,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const dwordDestination = await executeInstruction(
    [0x8c, 0xe0],
    createWasmCpuStateSnapshot({
      eax: 0xffff_ffff,
      fsSelector: 0x4321,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(wordDestination.exit);
  strictEqual(wordDestination.state.eax, 0xffff_1234);
  assertCompletedInstruction(wordDestination.state, startAddress + 3, 8);

  assertSingleInstructionExit(dwordDestination.exit);
  strictEqual(dwordDestination.state.eax, 0x4321);
  assertCompletedInstruction(dwordDestination.state, startAddress + 2, 8);
});

test("MOV to a segment register exits before committing the instruction", async () => {
  const initial = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    esSelector: 0x1111,
    eip: startAddress,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0x8e, 0xc0], initial);

  deepStrictEqual(exit, {
    kind: "segmentLoad",
    segment: "es",
    selector: 0x5678
  });
  deepStrictEqual(state, initial);
});

test("MOV to CS raises invalid-opcode before segment-load handling", async () => {
  const initial = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    csSelector: 0x1111,
    eip: startAddress,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0x8e, 0xc8], initial);

  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: invalidOpcode()
  });
  deepStrictEqual(state, initial);
});

test("interpreter dispatches the C7 /0 register form", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0xc7, 0xc0, 0x78, 0x56, 0x34, 0x12]);

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_5678);
});

test("executes CMOVcc r16 as a conditional partial register write", async () => {
  const taken = await executeInstruction(
    [0x66, 0x0f, 0x44, 0xd1],
    createWasmCpuStateSnapshot({
      ecx: 0x3333_2222,
      edx: 0xaaaa_1111,
      ZF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const notTaken = await executeInstruction(
    [0x66, 0x0f, 0x44, 0xd1],
    createWasmCpuStateSnapshot({
      ecx: 0x3333_2222,
      edx: 0xaaaa_1111,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(taken.exit);
  strictEqual(taken.state.edx, 0xaaaa_2222);
  deepStrictEqual(wasmCpuStatusFlagsOf(taken.state), zeroFlag);
  assertCompletedInstruction(taken.state, startAddress + 4, 8);

  assertSingleInstructionExit(notTaken.exit);
  strictEqual(notTaken.state.edx, 0xaaaa_1111);
  deepStrictEqual(wasmCpuStatusFlagsOf(notTaken.state), noFlags);
  assertCompletedInstruction(notTaken.state, startAddress + 4, 8);
});

test("CMOVcc r16 memory source faults even when condition is false", async () => {
  const initial = createWasmCpuStateSnapshot({
    ebx: 0x1_0000,
    edx: 0xaaaa_1111,
    ZF: 1,
    eip: startAddress,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0x66, 0x0f, 0x45, 0x13], initial);

  deepStrictEqual(exit, readPageFaultStop(0x1_0000));
  strictEqual(state.edx, initial.edx);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), wasmCpuStatusFlagsOf(initial));
  strictEqual(state.eip, initial.eip);
  strictEqual(state.instructionCount, initial.instructionCount);
});

test("executes register-only SETcc without modifying flags", async () => {
  const taken = await executeInstruction(
    [0x0f, 0x94, 0xc0],
    createWasmCpuStateSnapshot({ eax: 0x1234_5678, ZF: 1, eip: startAddress, instructionCount: 7 })
  );
  const notTaken = await executeInstruction(
    [0x0f, 0x94, 0xc0],
    createWasmCpuStateSnapshot({ eax: 0x1234_5678, eip: startAddress, instructionCount: 7 })
  );
  const highByte = await executeInstruction(
    [0x0f, 0x95, 0xc4],
    createWasmCpuStateSnapshot({ eax: 0x1234_5678, eip: startAddress, instructionCount: 7 })
  );

  assertSingleInstructionExit(taken.exit);
  strictEqual(taken.state.eax, 0x1234_5601);
  deepStrictEqual(wasmCpuStatusFlagsOf(taken.state), zeroFlag);
  assertCompletedInstruction(taken.state, startAddress + 3, 8);

  assertSingleInstructionExit(notTaken.exit);
  strictEqual(notTaken.state.eax, 0x1234_5600);
  deepStrictEqual(wasmCpuStatusFlagsOf(notTaken.state), noFlags);
  assertCompletedInstruction(notTaken.state, startAddress + 3, 8);

  assertSingleInstructionExit(highByte.exit);
  strictEqual(highByte.state.eax, 0x1234_0178);
  deepStrictEqual(wasmCpuStatusFlagsOf(highByte.state), noFlags);
  assertCompletedInstruction(highByte.state, startAddress + 3, 8);
});

test("executes memory SETcc as a selected byte store", async () => {
  const taken = await executeInstruction(
    [0x0f, 0x94, 0x03],
    createWasmCpuStateSnapshot({ ebx: 0x20, ZF: 1, eip: startAddress, instructionCount: 7 }),
    [{ address: 0x20, bytes: [0xaa] }]
  );
  const notTaken = await executeInstruction(
    [0x0f, 0x94, 0x03],
    createWasmCpuStateSnapshot({ ebx: 0x20, eip: startAddress, instructionCount: 7 }),
    [{ address: 0x20, bytes: [0xaa] }]
  );

  assertSingleInstructionExit(taken.exit);
  strictEqual(taken.guestView.getUint8(0x20), 1);
  deepStrictEqual(wasmCpuStatusFlagsOf(taken.state), zeroFlag);
  assertCompletedInstruction(taken.state, startAddress + 3, 8);

  assertSingleInstructionExit(notTaken.exit);
  strictEqual(notTaken.guestView.getUint8(0x20), 0);
  deepStrictEqual(wasmCpuStatusFlagsOf(notTaken.state), noFlags);
  assertCompletedInstruction(notTaken.state, startAddress + 3, 8);
});

test("executes multi-byte NOP without reading memory or modifying flags", async () => {
  const flags = allFlagsSet;
  const dword = await executeInstruction(
    [0x0f, 0x1f, 0x40, 0x00],
    createWasmCpuStateSnapshot({ eax: 0x1_0000, ...flags, eip: startAddress, instructionCount: 7 })
  );
  const word = await executeInstruction(
    [0x66, 0x0f, 0x1f, 0x00],
    createWasmCpuStateSnapshot({ eax: 0x1_0000, ...flags, eip: startAddress, instructionCount: 7 })
  );

  assertSingleInstructionExit(dword.exit);
  deepStrictEqual(wasmCpuStatusFlagsOf(dword.state), flags);
  assertCompletedInstruction(dword.state, startAddress + 4, 8);

  assertSingleInstructionExit(word.exit);
  deepStrictEqual(wasmCpuStatusFlagsOf(word.state), flags);
  assertCompletedInstruction(word.state, startAddress + 4, 8);
});

test("truncated MOV r32, imm32 returns decode fault without changing architectural state", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const eip = interpreter.guestView.byteLength - 3;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    eip,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, eip, [0xb8, 0x01, 0x02]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 1));
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
