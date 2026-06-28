import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  assertLazyFlagState,
  createWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf
} from "#runtime/tests/fixtures/cpu-state.js";
import { ExitReason } from "#wasm/exit.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { assertCompletedInstruction, assertSingleInstructionExit, executeInstruction } from "./support.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;
const imulNoOverflowFlags = { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;
const imulOverflowFlags = { CF: 1, PF: 1, AF: 0, ZF: 0, SF: 0, OF: 1 } as const;

test("executes IMUL r32, r/m32 and writes deterministic explicit flags", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 3,
    ebx: 0xffff_fffe,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0f, 0xaf, 0xc3], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_fffa);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), imulNoOverflowFlags);
  assertLazyFlagState(state, { kind: "NONE", width: 0 });
});

test("executes overflowing IMUL r32, r/m32 with CF and OF set", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x4000_0000,
    ebx: 2,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0f, 0xaf, 0xc3], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x8000_0000);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), imulOverflowFlags);
});

test("executes IMUL r16, r/m16 without modifying the high destination word", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_0003,
    ebx: 0x0000_fffe,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x0f, 0xaf, 0xc3], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x1234_fffa);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 4, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), imulNoOverflowFlags);
});

test("executes IMUL immediate forms with signed immediates", async () => {
  const imm32 = await executeInstruction(
    [0x69, 0xc3, 0xff, 0xff, 0xff, 0xff],
    createWasmCpuStateSnapshot({
      ebx: 5,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );
  const imm8 = await executeInstruction(
    [0x6b, 0xc3, 0xfe],
    createWasmCpuStateSnapshot({
      ebx: 5,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(imm32.exit);
  strictEqual(imm32.state.eax, 0xffff_fffb);
  assertCompletedInstruction(imm32.state, startAddress + 6, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(imm32.state), imulNoOverflowFlags);

  assertSingleInstructionExit(imm8.exit);
  strictEqual(imm8.state.eax, 0xffff_fff6);
  assertCompletedInstruction(imm8.state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(imm8.state), imulNoOverflowFlags);
});

test("faulting IMUL memory source leaves destination and flags unchanged", async () => {
  const faultAddress = 0x1_0000;
  const initialState = createWasmCpuStateSnapshot({
    eax: 7,
    ebx: faultAddress,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0f, 0xaf, 0x03], initialState);

  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: faultAddress, detail: 4 });
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress, 7);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});
