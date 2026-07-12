import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  createWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf
} from "#test/support/cpu-state.js";
import { divideErrorExit, readPageFaultExit } from "#wasm/tests/exit-fixtures.js";
import { startAddress } from "#test/support/addresses.js";
import { assertCompletedInstruction, assertSingleInstructionExit, executeInstruction } from "./support.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;
const guestByteLength = 0x10000;

test("executes unsigned DIV byte form into AH:AL", async () => {
  const { exit, state } = await executeInstruction(
    [0xf6, 0xf3],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_0035,
      ebx: 6,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_0508);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});

test("executes unsigned DIV word form into DX:AX", async () => {
  const { exit, state } = await executeInstruction(
    [0x66, 0xf7, 0xf3],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_0000,
      ebx: 0x0000_0100,
      edx: 0xbbbb_0001,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_0100);
  strictEqual(state.edx, 0xbbbb_0000);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});

test("executes unsigned DIV dword form into EDX:EAX", async () => {
  const { exit, state } = await executeInstruction(
    [0xf7, 0xf3],
    createWasmCpuStateSnapshot({
      eax: 0,
      ebx: 2,
      edx: 1,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x8000_0000);
  strictEqual(state.edx, 0);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});

test("executes signed IDIV positive word form", async () => {
  const { exit, state } = await executeInstruction(
    [0x66, 0xf7, 0xfb],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_012c,
      ebx: 7,
      edx: 0xbbbb_0000,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_002a);
  strictEqual(state.edx, 0xbbbb_0006);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});

test("executes signed IDIV negative dword form with dividend-signed remainder", async () => {
  const { exit, state } = await executeInstruction(
    [0xf7, 0xfb],
    createWasmCpuStateSnapshot({
      eax: 0xffff_fff9,
      ebx: 2,
      edx: 0xffff_ffff,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_fffd);
  strictEqual(state.edx, 0xffff_ffff);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});

test("executes unsigned DIV dword form with the widest fitting quotient", async () => {
  const { exit, state } = await executeInstruction(
    [0xf7, 0xf3],
    createWasmCpuStateSnapshot({
      eax: 0xffff_fffd,
      ebx: 6,
      edx: 5,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xffff_ffff);
  strictEqual(state.edx, 3);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});

test("executes signed IDIV byte form with an inexact boundary quotient", async () => {
  const { exit, state } = await executeInstruction(
    [0xf6, 0xfb],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_04fb,
      ebx: 0x0000_000a,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_057f);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});

test("executes signed IDIV byte form with an inexact negative boundary quotient", async () => {
  const { exit, state } = await executeInstruction(
    [0xf6, 0xfb],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_fafc,
      ebx: 0x0000_000a,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_fc80);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});

test("executes signed IDIV word form with an inexact boundary quotient", async () => {
  const { exit, state } = await executeInstruction(
    [0x66, 0xf7, 0xfb],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_ffff,
      ebx: 2,
      edx: 0xbbbb_0000,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_7fff);
  strictEqual(state.edx, 0xbbbb_0001);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});

test("executes signed IDIV dword form with an inexact boundary quotient", async () => {
  const { exit, state } = await executeInstruction(
    [0xf7, 0xfb],
    createWasmCpuStateSnapshot({
      eax: 0xffff_ffff,
      ebx: 2,
      edx: 0,
      eip: startAddress,
      ...allFlagsSet,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0x7fff_ffff);
  strictEqual(state.edx, 1);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});

test("DIV by zero raises divide error without changing architectural state", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    ebx: 0,
    edx: 0x89ab_cdef,
    eip: startAddress,
    DF: 1,
    ...allFlagsSet,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0xf7, 0xf3], initialState);

  deepStrictEqual(exit, divideErrorExit());
  deepStrictEqual(state, initialState);
});

test("DIV quotient overflow raises divide error before writes", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    ebx: 5,
    edx: 5,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0xf7, 0xf3], initialState);

  deepStrictEqual(exit, divideErrorExit());
  deepStrictEqual(state, initialState);
});

test("IDIV signed quotient overflow raises divide error before wasm division", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x8000_0000,
    ebx: 0xffff_ffff,
    edx: 0xffff_ffff,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0xf7, 0xfb], initialState);

  deepStrictEqual(exit, divideErrorExit());
  deepStrictEqual(state, initialState);
});

test("IDIV by zero raises divide error without changing architectural state", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    ebx: 0,
    edx: 0x89ab_cdef,
    eip: startAddress,
    DF: 1,
    ...allFlagsSet,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0xf7, 0xfb], initialState);

  deepStrictEqual(exit, divideErrorExit());
  deepStrictEqual(state, initialState);
});

test("IDIV word form INT32_MIN over -1 raises divide error instead of trapping", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xaaaa_0000,
    ebx: 0x0000_ffff,
    edx: 0xbbbb_8000,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0x66, 0xf7, 0xfb], initialState);

  deepStrictEqual(exit, divideErrorExit());
  deepStrictEqual(state, initialState);
});

test("IDIV quotient just past the signed range raises divide error", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    ebx: 2,
    edx: 1,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0xf7, 0xfb], initialState);

  deepStrictEqual(exit, divideErrorExit());
  deepStrictEqual(state, initialState);
});

test("DIV memory source fault takes priority over divide error", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    ebx: guestByteLength,
    edx: 1,
    eip: startAddress,
    ...allFlagsSet,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0xf7, 0x33], initialState);

  deepStrictEqual(exit, readPageFaultExit(guestByteLength));
  deepStrictEqual(state, initialState);
});
