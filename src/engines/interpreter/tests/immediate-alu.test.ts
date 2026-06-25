import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { assertLazyFlagState, createWasmCpuStateSnapshot, wasmCpuStatusFlagsOf } from "#runtime/tests/fixtures/cpu-state.js";
import {
  assertInterpreterStateEquals,
  writeInterpreterState
} from "./interpreter-helpers.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { ExitReason } from "#wasm/exit.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  executeInstruction,
  executeProgram,
  instantiateWasmInterpreter,
  writeGuestBytes
} from "./support.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

const addWraparoundFlags = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 0, OF: 0 } as const;
const subBorrowFlags = { CF: 1, PF: 1, AF: 1, ZF: 0, SF: 1, OF: 0 } as const;
const zeroResultFlags = { CF: 0, PF: 1, AF: 0, ZF: 1, SF: 0, OF: 0 } as const;
const carryAuxFlags = { CF: 1, PF: 0, AF: 1, ZF: 0, SF: 0, OF: 0 } as const;
const parityOnlyFlags = { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;
const signParityFlags = { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 1, OF: 0 } as const;
const adcNoCarryFlags = { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;
const adcWithCarryFlags = { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;
const adcSignedOverflowFlags = { CF: 0, PF: 1, AF: 1, ZF: 0, SF: 1, OF: 1 } as const;
const sbbNoBorrowFlags = { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;
const sbbWithBorrowFlags = { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;
const sbbSignedOverflowFlags = { CF: 0, PF: 1, AF: 1, ZF: 0, SF: 0, OF: 1 } as const;

test("executes ADD EAX, imm32", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_ffff,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x05, 0x01, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  assertCompletedInstruction(state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), addWraparoundFlags);
});

test("executes SUB EAX, imm32", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x2d, 0x01, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_ffff);
  assertCompletedInstruction(state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "SUB", width: 32, a: 0, b: 1 });
});

test("executes ADC EAX, imm32 with old CF clear or set", async () => {
  const withoutCarry = await executeInstruction(
    [0x15, 0x01, 0x00, 0x00, 0x00],
    createWasmCpuStateSnapshot({
      eax: 1,
      eip: startAddress,
      ...allFlagsSet,
      CF: 0,
      instructionCount: 7
    })
  );
  const withCarry = await executeInstruction(
    [0x15, 0x01, 0x00, 0x00, 0x00],
    createWasmCpuStateSnapshot({
      eax: 1,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(withoutCarry.exit);
  strictEqual(withoutCarry.state.eax, 2);
  assertCompletedInstruction(withoutCarry.state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(withoutCarry.state), adcNoCarryFlags);

  assertSingleInstructionExit(withCarry.exit);
  strictEqual(withCarry.state.eax, 3);
  assertCompletedInstruction(withCarry.state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(withCarry.state), adcWithCarryFlags);
});

test("executes SBB EAX, imm32 with old CF clear or set", async () => {
  const withoutBorrow = await executeInstruction(
    [0x1d, 0x01, 0x00, 0x00, 0x00],
    createWasmCpuStateSnapshot({
      eax: 5,
      eip: startAddress,
      ...allFlagsSet,
      CF: 0,
      instructionCount: 7
    })
  );
  const withBorrow = await executeInstruction(
    [0x1d, 0x01, 0x00, 0x00, 0x00],
    createWasmCpuStateSnapshot({
      eax: 5,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(withoutBorrow.exit);
  strictEqual(withoutBorrow.state.eax, 4);
  assertCompletedInstruction(withoutBorrow.state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(withoutBorrow.state), sbbNoBorrowFlags);

  assertSingleInstructionExit(withBorrow.exit);
  strictEqual(withBorrow.state.eax, 3);
  assertCompletedInstruction(withBorrow.state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(withBorrow.state), sbbWithBorrowFlags);
});

test("executes ADD AX, imm16 with 16-bit wraparound", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_0001,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x05, 0xff, 0xff], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_0000);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("executes ADD AX, imm16 without leaking carry into high EAX", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_ffff,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x05, 0x01, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_0000);
  assertCompletedInstruction(state, startAddress + 4, 8);
});

test("executes SUB AX, imm16 without borrowing from high EAX", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_0000,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x2d, 0x01, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_ffff);
  assertCompletedInstruction(state, startAddress + 4, 8);
  assertLazyFlagState(state, { kind: "SUB", width: 16, a: 0, b: 1 });
});

test("executes ADD AL, imm8 without leaking carry into high EAX", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_00ff,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x04, 0x01], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_0000);
  assertCompletedInstruction(state, startAddress + 2, 8);
});

test("executes SUB AL, imm8 without borrowing from high EAX", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_0000,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x2c, 0x01], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_00ff);
  assertCompletedInstruction(state, startAddress + 2, 8);
  assertLazyFlagState(state, { kind: "SUB", width: 8, a: 0, b: 1 });
});

test("executes ADC AL, imm8 without leaking carry into high EAX", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_00fe,
    CF: 1,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x14, 0x01], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_0000);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), addWraparoundFlags);
});

test("executes SBB AX, imm16 without borrowing from high EAX", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_0001,
    CF: 1,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x1d, 0x01, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_ffff);
  assertCompletedInstruction(state, startAddress + 4, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), subBorrowFlags);
});

test("executes XOR EAX, imm32", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_ffff,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x35, 0xff, 0xff, 0xff, 0xff], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  assertCompletedInstruction(state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), zeroResultFlags);
});

test("executes OR EAX, imm32", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x8000_0000,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0d, 0x00, 0x01, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x8000_0100);
  assertCompletedInstruction(state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), signParityFlags);
});

test("executes AND EAX, imm32", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_ffff,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x25, 0x00, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  assertCompletedInstruction(state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), zeroResultFlags);
});

test("executes CMP EAX, imm32 without writing EAX", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 5,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x3d, 0x05, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  assertCompletedInstruction(state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "SUB", width: 32, a: 5, b: 5 });
});

test("executes TEST EAX, imm32 without writing EAX", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xff,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0xa9, 0xff, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  assertCompletedInstruction(state, startAddress + 5, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), parityOnlyFlags);
});

test("executes 81 /7 CMP r/m32, imm32 for register operands", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x81, 0xf8, 0x00, 0x00, 0x00, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  assertCompletedInstruction(state, startAddress + 6, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "SUB", width: 32, a: 0, b: 0 });
});

test("executes 83 /5 SUB r/m32, sign-extended imm8 for register operands", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 1,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x83, 0xe8, 0xff], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 2);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
  assertLazyFlagState(state, { kind: "SUB", width: 32, a: 1, b: 0xffff_ffff });
});

test("executes 83 /6 XOR r/m32, sign-extended imm8 for register operands", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x83, 0xf0, 0xff], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_ffff);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), signParityFlags);
});

test("executes 83 /4 AND r/m32, sign-extended imm8 for register operands", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xffff_ffff,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x83, 0xe0, 0x00], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), zeroResultFlags);
});

test("executes 83 /2 ADC and 83 /3 SBB sign-extended imm8 for register operands", async () => {
  const adc = await executeInstruction(
    [0x83, 0xd0, 0xff],
    createWasmCpuStateSnapshot({
      eax: 1,
      CF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const sbb = await executeInstruction(
    [0x83, 0xd8, 0xff],
    createWasmCpuStateSnapshot({
      eax: 1,
      CF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(adc.exit);
  strictEqual(adc.state.eax, 1);
  assertCompletedInstruction(adc.state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(adc.state), carryAuxFlags);

  assertSingleInstructionExit(sbb.exit);
  strictEqual(sbb.state.eax, 1);
  assertCompletedInstruction(sbb.state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(sbb.state), carryAuxFlags);
});

test("ADC and SBB immediate forms materialize carry and overflow edge flags", async () => {
  const cases = [
    {
      name: "adc carry out",
      bytes: [0x15, 0x00, 0x00, 0x00, 0x00],
      initialEax: 0xffff_ffff,
      expectedEax: 0,
      expectedFlags: addWraparoundFlags
    },
    {
      name: "adc signed overflow",
      bytes: [0x15, 0x00, 0x00, 0x00, 0x00],
      initialEax: 0x7fff_ffff,
      expectedEax: 0x8000_0000,
      expectedFlags: adcSignedOverflowFlags
    },
    {
      name: "sbb borrow out",
      bytes: [0x1d, 0x00, 0x00, 0x00, 0x00],
      initialEax: 0,
      expectedEax: 0xffff_ffff,
      expectedFlags: subBorrowFlags
    },
    {
      name: "sbb signed overflow",
      bytes: [0x1d, 0x00, 0x00, 0x00, 0x00],
      initialEax: 0x8000_0000,
      expectedEax: 0x7fff_ffff,
      expectedFlags: sbbSignedOverflowFlags
    }
  ] as const;

  for (const entry of cases) {
    const { exit, state } = await executeInstruction(
      entry.bytes,
      createWasmCpuStateSnapshot({
        eax: entry.initialEax,
        CF: 1,
        eip: startAddress,
        instructionCount: 7
      })
    );

    assertSingleInstructionExit(exit);
    strictEqual(state.eax, entry.expectedEax, entry.name);
    assertCompletedInstruction(state, startAddress + 5, 8);
    deepStrictEqual(wasmCpuStatusFlagsOf(state), entry.expectedFlags, entry.name);
  }
});

test("SETcc after ADC observes the newly written ZF", async () => {
  const bytes = [
    0x15, 0x00, 0x00, 0x00, 0x00, // adc eax, 0
    0x0f, 0x94, 0xc3 // setz bl
  ];
  const { exit, state } = await executeProgram(
    bytes,
    createWasmCpuStateSnapshot({
      eax: 0xffff_ffff,
      ebx: 0xaaaa_aa55,
      CF: 1,
      eip: startAddress,
      instructionCount: 7
    }),
    2
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0);
  strictEqual(state.ebx, 0xaaaa_aa01);
  assertCompletedInstruction(state, startAddress + bytes.length, 9);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), addWraparoundFlags);
});

test("SETcc after SBB observes new CF and OF instead of the old carry input", async () => {
  const bytes = [
    0x1d, 0x00, 0x00, 0x00, 0x00, // sbb eax, 0
    0x0f, 0x92, 0xc3, // setb bl
    0x0f, 0x90, 0xc1 // seto cl
  ];
  const { exit, state } = await executeProgram(
    bytes,
    createWasmCpuStateSnapshot({
      eax: 0x8000_0000,
      ebx: 0x1122_3344,
      ecx: 0x5566_7788,
      CF: 1,
      eip: startAddress,
      instructionCount: 7
    }),
    3
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x7fff_ffff);
  strictEqual(state.ebx, 0x1122_3300);
  strictEqual(state.ecx, 0x5566_7701);
  assertCompletedInstruction(state, startAddress + bytes.length, 10);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), sbbSignedOverflowFlags);
});

test("ADC memory destination fault leaves architectural state unchanged", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const faultAddress = interpreter.guestView.byteLength - 3;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x83, 0x15, ...disp32(faultAddress), 0x01]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: faultAddress, detail: 4 });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("SBB memory source fault leaves architectural state unchanged", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const faultAddress = interpreter.guestView.byteLength - 3;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, startAddress, [0x1b, 0x05, ...disp32(faultAddress)]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: faultAddress, detail: 4 });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

test("unsupported F7 /1 group returns unsupported after ModRM dispatch", async () => {
  const interpreter = await instantiateWasmInterpreter();
  const eip = interpreter.guestView.byteLength - 2;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    eip,
    ...allFlagsSet,
    instructionCount: 7
  });
  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, eip, [0xf7, 0xc8]);

  const exit = interpreter.run(1);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});

function disp32(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}
