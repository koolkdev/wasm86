import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { flagsOf,
  createCpuState } from "#x86/state/cpu-state.js";
import {
  assertInterpreterStateEquals,
  readInterpreterState,
  writeInterpreterState
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { ExitReason } from "#wasm/exit.js";
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

test("executes MOV eax, imm32", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createCpuState({
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0xb8, 0x78, 0x56, 0x34, 0x12]);

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_5678);
  assertCompletedInstruction(state, startAddress + 5, 8);
  strictEqual(state.ebx, initialState.ebx);
});

test("executes MOV edi, imm32 through opcode register low bits", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createCpuState({
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
  assertCompletedInstruction(state, startAddress + 5, 8);
});

test("executes MOV r/m32, imm32 through C7 group", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const initialState = createCpuState({
    eip: startAddress,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0xc7, 0xc0, 0x78, 0x56, 0x34, 0x12]);

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_5678);
  assertCompletedInstruction(state, startAddress + 6, 8);
});

test("executes MOVZX and MOVSX register forms without modifying flags", async () => {
  const flags = allFlagsSet;
  const zeroExtend = await executeInstruction(
    [0x0f, 0xb6, 0xc7],
    createCpuState({ eax: 0xaaaa_aaaa, ebx: 0x1234_807f, ...flags, eip: startAddress, instructionCount: 7 })
  );
  const signExtend = await executeInstruction(
    [0x0f, 0xbe, 0xcf],
    createCpuState({ ebx: 0x1234_807f, ...flags, eip: startAddress, instructionCount: 7 })
  );
  const zeroExtendWordDestination = await executeInstruction(
    [0x66, 0x0f, 0xb6, 0xc3],
    createCpuState({ eax: 0x1234_0000, ebx: 0x80, ...flags, eip: startAddress, instructionCount: 7 })
  );
  const signExtendWordDestination = await executeInstruction(
    [0x66, 0x0f, 0xbe, 0xc3],
    createCpuState({ eax: 0x1234_0000, ebx: 0x80, ...flags, eip: startAddress, instructionCount: 7 })
  );

  assertSingleInstructionExit(zeroExtend.exit);
  strictEqual(zeroExtend.state.eax, 0x80);
  deepStrictEqual(flagsOf(zeroExtend.state), flags);
  assertCompletedInstruction(zeroExtend.state, startAddress + 3, 8);

  assertSingleInstructionExit(signExtend.exit);
  strictEqual(signExtend.state.ecx, 0xffff_ff80);
  deepStrictEqual(flagsOf(signExtend.state), flags);
  assertCompletedInstruction(signExtend.state, startAddress + 3, 8);

  assertSingleInstructionExit(zeroExtendWordDestination.exit);
  strictEqual(zeroExtendWordDestination.state.eax, 0x1234_0080);
  deepStrictEqual(flagsOf(zeroExtendWordDestination.state), flags);
  assertCompletedInstruction(zeroExtendWordDestination.state, startAddress + 4, 8);

  assertSingleInstructionExit(signExtendWordDestination.exit);
  strictEqual(signExtendWordDestination.state.eax, 0x1234_ff80);
  deepStrictEqual(flagsOf(signExtendWordDestination.state), flags);
  assertCompletedInstruction(signExtendWordDestination.state, startAddress + 4, 8);
});

test("executes MOVSX r16 from byte register before BL/BX/EBX alias operations", async () => {
  const bytes = [
    0x66, 0x0f, 0xbe, 0xd8, // movsx bx, al
    0x80, 0xc3, 0x01, // add bl, 1
    0x66, 0x83, 0xc3, 0x01, // add bx, 1
    0x83, 0xc3, 0x01 // add ebx, 1
  ];
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, createCpuState({
    eax: 0x80,
    ebx: 0x1122_3344,
    eip: startAddress,
    instructionCount: 7
  }));
  writeGuestBytes(interpreter.guestView, startAddress, bytes);

  const exit = interpreter.run(4);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x80);
  strictEqual(state.ebx, 0x1122_ff83);
  assertCompletedInstruction(state, startAddress + bytes.length, 11);
});

test("executes MOVSX from a word register copy", async () => {
  const bytes = [
    0x66, 0x89, 0xd8, // mov ax, bx
    0x0f, 0xbf, 0xc8 // movsx ecx, ax
  ];
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, createCpuState({
    eax: 0x1234_0000,
    ebx: 0x0000_8001,
    ecx: 0xcccc_cccc,
    ...allFlagsSet,
    eip: startAddress,
    instructionCount: 7
  }));
  writeGuestBytes(interpreter.guestView, startAddress, bytes);

  const exit = interpreter.run(2);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_8001);
  strictEqual(state.ebx, 0x0000_8001);
  strictEqual(state.ecx, 0xffff_8001);
  deepStrictEqual(flagsOf(state), allFlagsSet);
  assertCompletedInstruction(state, startAddress + bytes.length, 9);
});

test("executes MOVZX and MOVSX memory forms", async () => {
  const flags = allFlagsSet;
  const zeroExtendByte = await executeMovWithMemory(
    [0x0f, 0xb6, 0x03],
    createCpuState({ eax: 0xffff_ffff, ebx: 0x20, ...flags, eip: startAddress, instructionCount: 7 }),
    (guest) => guest.setUint8(0x20, 0xfe)
  );
  const zeroExtend = await executeMovWithMemory(
    [0x0f, 0xb7, 0x03],
    createCpuState({ eax: 0xffff_ffff, ebx: 0x20, ...flags, eip: startAddress, instructionCount: 7 }),
    (guest) => guest.setUint16(0x20, 0x80ff, true)
  );
  const signExtendByte = await executeMovWithMemory(
    [0x0f, 0xbe, 0x03],
    createCpuState({ ebx: 0x20, ...flags, eip: startAddress, instructionCount: 7 }),
    (guest) => guest.setUint8(0x20, 0x80)
  );
  const signExtend = await executeMovWithMemory(
    [0x0f, 0xbf, 0x03],
    createCpuState({ ebx: 0x20, ...flags, eip: startAddress, instructionCount: 7 }),
    (guest) => guest.setUint16(0x20, 0x8001, true)
  );

  assertSingleInstructionExit(zeroExtendByte.exit);
  strictEqual(zeroExtendByte.state.eax, 0xfe);
  deepStrictEqual(flagsOf(zeroExtendByte.state), flags);
  assertCompletedInstruction(zeroExtendByte.state, startAddress + 3, 8);

  assertSingleInstructionExit(zeroExtend.exit);
  strictEqual(zeroExtend.state.eax, 0x80ff);
  deepStrictEqual(flagsOf(zeroExtend.state), flags);
  assertCompletedInstruction(zeroExtend.state, startAddress + 3, 8);

  assertSingleInstructionExit(signExtendByte.exit);
  strictEqual(signExtendByte.state.eax, 0xffff_ff80);
  deepStrictEqual(flagsOf(signExtendByte.state), flags);
  assertCompletedInstruction(signExtendByte.state, startAddress + 3, 8);

  assertSingleInstructionExit(signExtend.exit);
  strictEqual(signExtend.state.eax, 0xffff_8001);
  deepStrictEqual(flagsOf(signExtend.state), flags);
  assertCompletedInstruction(signExtend.state, startAddress + 3, 8);
});

test("executes CMOVcc r16 as a conditional partial register write", async () => {
  const taken = await executeInstruction(
    [0x66, 0x0f, 0x44, 0xd1],
    createCpuState({
      ecx: 0x3333_2222,
      edx: 0xaaaa_1111,
      ZF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const notTaken = await executeInstruction(
    [0x66, 0x0f, 0x44, 0xd1],
    createCpuState({
      ecx: 0x3333_2222,
      edx: 0xaaaa_1111,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(taken.exit);
  strictEqual(taken.state.edx, 0xaaaa_2222);
  deepStrictEqual(flagsOf(taken.state), zeroFlag);
  assertCompletedInstruction(taken.state, startAddress + 4, 8);

  assertSingleInstructionExit(notTaken.exit);
  strictEqual(notTaken.state.edx, 0xaaaa_1111);
  deepStrictEqual(flagsOf(notTaken.state), noFlags);
  assertCompletedInstruction(notTaken.state, startAddress + 4, 8);
});

test("CMOVcc r16 memory source faults even when condition is false", async () => {
  const initial = createCpuState({
    ebx: 0x1_0000,
    edx: 0xaaaa_1111,
    ZF: 1,
    eip: startAddress,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0x66, 0x0f, 0x45, 0x13], initial);

  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x1_0000, detail: 2 });
  strictEqual(state.edx, initial.edx);
  deepStrictEqual(flagsOf(state), flagsOf(initial));
  strictEqual(state.eip, initial.eip);
  strictEqual(state.instructionCount, initial.instructionCount);
});

test("executes register-only SETcc without modifying flags", async () => {
  const taken = await executeInstruction(
    [0x0f, 0x94, 0xc0],
    createCpuState({ eax: 0x1234_5678, ZF: 1, eip: startAddress, instructionCount: 7 })
  );
  const notTaken = await executeInstruction(
    [0x0f, 0x94, 0xc0],
    createCpuState({ eax: 0x1234_5678, eip: startAddress, instructionCount: 7 })
  );
  const highByte = await executeInstruction(
    [0x0f, 0x95, 0xc4],
    createCpuState({ eax: 0x1234_5678, eip: startAddress, instructionCount: 7 })
  );

  assertSingleInstructionExit(taken.exit);
  strictEqual(taken.state.eax, 0x1234_5601);
  deepStrictEqual(flagsOf(taken.state), zeroFlag);
  assertCompletedInstruction(taken.state, startAddress + 3, 8);

  assertSingleInstructionExit(notTaken.exit);
  strictEqual(notTaken.state.eax, 0x1234_5600);
  deepStrictEqual(flagsOf(notTaken.state), noFlags);
  assertCompletedInstruction(notTaken.state, startAddress + 3, 8);

  assertSingleInstructionExit(highByte.exit);
  strictEqual(highByte.state.eax, 0x1234_0178);
  deepStrictEqual(flagsOf(highByte.state), noFlags);
  assertCompletedInstruction(highByte.state, startAddress + 3, 8);
});

test("executes memory SETcc as a selected byte store", async () => {
  const taken = await executeInstruction(
    [0x0f, 0x94, 0x03],
    createCpuState({ ebx: 0x20, ZF: 1, eip: startAddress, instructionCount: 7 }),
    [{ address: 0x20, bytes: [0xaa] }]
  );
  const notTaken = await executeInstruction(
    [0x0f, 0x94, 0x03],
    createCpuState({ ebx: 0x20, eip: startAddress, instructionCount: 7 }),
    [{ address: 0x20, bytes: [0xaa] }]
  );

  assertSingleInstructionExit(taken.exit);
  strictEqual(taken.guestView.getUint8(0x20), 1);
  deepStrictEqual(flagsOf(taken.state), zeroFlag);
  assertCompletedInstruction(taken.state, startAddress + 3, 8);

  assertSingleInstructionExit(notTaken.exit);
  strictEqual(notTaken.guestView.getUint8(0x20), 0);
  deepStrictEqual(flagsOf(notTaken.state), noFlags);
  assertCompletedInstruction(notTaken.state, startAddress + 3, 8);
});

test("executes multi-byte NOP without reading memory or modifying flags", async () => {
  const flags = allFlagsSet;
  const dword = await executeInstruction(
    [0x0f, 0x1f, 0x40, 0x00],
    createCpuState({ eax: 0x1_0000, ...flags, eip: startAddress, instructionCount: 7 })
  );
  const word = await executeInstruction(
    [0x66, 0x0f, 0x1f, 0x00],
    createCpuState({ eax: 0x1_0000, ...flags, eip: startAddress, instructionCount: 7 })
  );

  assertSingleInstructionExit(dword.exit);
  deepStrictEqual(flagsOf(dword.state), flags);
  assertCompletedInstruction(dword.state, startAddress + 4, 8);

  assertSingleInstructionExit(word.exit);
  deepStrictEqual(flagsOf(word.state), flags);
  assertCompletedInstruction(word.state, startAddress + 4, 8);
});

test("truncated MOV r32, imm32 returns decode fault without changing architectural state", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const eip = interpreter.guestView.byteLength - 3;
  const initialState = createCpuState({
    eax: 0x1122_3344,
    eip,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, eip, [0xb8, 0x01, 0x02]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, { exitReason: ExitReason.DECODE_FAULT, payload: eip + 1, detail: 4 });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

async function executeMovWithMemory(
  bytes: readonly number[],
  initialState: ReturnType<typeof createCpuState>,
  setupGuest: (view: DataView) => void
) {
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, bytes);
  setupGuest(interpreter.guestView);

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  return { exit, state };
}
