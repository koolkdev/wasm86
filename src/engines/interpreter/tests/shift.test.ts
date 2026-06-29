import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { assertLazyFlagState, createWasmCpuStateSnapshot, wasmCpuStatusFlagsOf } from "#runtime/tests/fixtures/cpu-state.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { assertCompletedInstruction, assertSingleInstructionExit, executeInstruction } from "./support.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

test("executes SHL r/m32, 1 and writes explicit shift flags", async () => {
  const initialState = createWasmCpuStateSnapshot({
    ebx: 0x4000_0000,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0xd1, 0xe3], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.ebx, 0x8000_0000);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 1, OF: 1 });
  assertLazyFlagState(state, { kind: "NONE", width: 0 });
});

test("executes SHR r/m32, CL with a masked count", async () => {
  const initialState = createWasmCpuStateSnapshot({
    ebx: 0x8000_0000,
    ecx: 0x21,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0xd3, 0xeb], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.ebx, 0x4000_0000);
  strictEqual(state.ecx, initialState.ecx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 0, OF: 1 });
  assertLazyFlagState(state, { kind: "NONE", width: 0 });
});

test("executes SAR r/m16, imm8 without touching the high register bits", async () => {
  const initialState = createWasmCpuStateSnapshot({
    ebx: 0x1234_8000,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0xc1, 0xfb, 0x04], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.ebx, 0x1234_f800);
  assertCompletedInstruction(state, startAddress + 4, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 1, OF: 0 });
  assertLazyFlagState(state, { kind: "NONE", width: 0 });
});

test("executes SHLD r/m32, r32, imm8 with source bits shifted into the destination", async () => {
  const initialState = createWasmCpuStateSnapshot({
    ebx: 0x1234_5678,
    ecx: 0x9abc_def0,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0f, 0xa4, 0xcb, 0x04], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.ebx, 0x2345_6789);
  strictEqual(state.ecx, initialState.ecx);
  assertCompletedInstruction(state, startAddress + 4, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 1, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 });
  assertLazyFlagState(state, { kind: "NONE", width: 0 });
});

test("executes SHRD r/m16, r16, CL without touching the high register bits", async () => {
  const initialState = createWasmCpuStateSnapshot({
    ebx: 0xaaaa_1234,
    edx: 0xbbbb_abcd,
    ecx: 4,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0x0f, 0xad, 0xd3], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.ebx, 0xaaaa_d123);
  strictEqual(state.edx, initialState.edx);
  strictEqual(state.ecx, initialState.ecx);
  assertCompletedInstruction(state, startAddress + 4, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 1, OF: 0 });
  assertLazyFlagState(state, { kind: "NONE", width: 0 });
});

test("executes count-one double shifts with defined overflow flags", async () => {
  const shld = await executeInstruction(
    [0x0f, 0xa4, 0xd8, 0x01],
    createWasmCpuStateSnapshot({
      eax: 0x4000_0000,
      ebx: 0x8000_0000,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const shrd = await executeInstruction(
    [0x0f, 0xac, 0xd8, 0x01],
    createWasmCpuStateSnapshot({
      eax: 0x8000_0001,
      ebx: 0,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(shld.exit);
  strictEqual(shld.state.eax, 0x8000_0001);
  assertCompletedInstruction(shld.state, startAddress + 4, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(shld.state), { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 1, OF: 1 });

  assertSingleInstructionExit(shrd.exit);
  strictEqual(shrd.state.eax, 0x4000_0000);
  assertCompletedInstruction(shrd.state, startAddress + 4, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(shrd.state), { CF: 1, PF: 1, AF: 0, ZF: 0, SF: 0, OF: 1 });
});

test("preserves the destination and old flags for a zero shift count", async () => {
  const flags = { CF: 1, PF: 0, AF: 1, ZF: 0, SF: 1, OF: 0 } as const;
  const initialState = createWasmCpuStateSnapshot({
    ebx: 0x1234_5678,
    ecx: 0,
    eip: startAddress,
    ...flags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0xd3, 0xeb], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), flags);
  assertLazyFlagState(state, { kind: "NONE", width: 0 });
});

test("preserves the destination and old flags for a zero double-shift count", async () => {
  const flags = { CF: 1, PF: 0, AF: 1, ZF: 0, SF: 1, OF: 0 } as const;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    ebx: 0x9abc_def0,
    ecx: 0,
    eip: startAddress,
    ...flags,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0f, 0xa5, 0xd8], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), flags);
  assertLazyFlagState(state, { kind: "NONE", width: 0 });
});
