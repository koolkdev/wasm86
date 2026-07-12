import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  createWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf
} from "#test/support/cpu-state.js";
import { writePageFaultExit } from "#wasm/tests/exit-fixtures.js";
import { startAddress } from "#test/support/addresses.js";
import { assertCompletedInstruction, assertSingleInstructionExit, executeInstruction } from "./support.js";

const preservedFlags = { PF: 1, AF: 1, ZF: 1, SF: 1 } as const;
const cfOfClear = { ...preservedFlags, CF: 0, OF: 0 } as const;
const cfOfSet = { ...preservedFlags, CF: 1, OF: 1 } as const;

test("executes ROL byte and dword forms with carry and overflow results", async () => {
  const byte = await executeInstruction(
    [0xd0, 0xc0],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_0081,
      ...cfOfClear,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const dword = await executeInstruction(
    [0xd3, 0xc3],
    createWasmCpuStateSnapshot({
      ebx: 0x1234_5678,
      ecx: 4,
      ...cfOfSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(byte.exit);
  strictEqual(byte.state.eax, 0xaaaa_0003);
  assertCompletedInstruction(byte.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(byte.state), { ...preservedFlags, CF: 1, OF: 1 });

  assertSingleInstructionExit(dword.exit);
  strictEqual(dword.state.ebx, 0x2345_6781);
  assertCompletedInstruction(dword.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(dword.state), { ...preservedFlags, CF: 1, OF: 0 });
});

test("executes ROR word form without modifying high EAX bits", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xaaaa_0001,
    ...cfOfClear,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x66, 0xd1, 0xc8], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_8000);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { ...preservedFlags, CF: 1, OF: 1 });
});

test("nonzero full-width ROL updates CF and clears undefined OF", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xaaaa_0081,
    ...cfOfClear,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0xc0, 0xc0, 0x08], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_0081);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { ...preservedFlags, CF: 1, OF: 0 });
});

test("executes RCL with old carry clear and set", async () => {
  const carryClear = await executeInstruction(
    [0xd0, 0xd3],
    createWasmCpuStateSnapshot({
      ebx: 0xaaaa_0080,
      ...cfOfClear,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const carrySet = await executeInstruction(
    [0xd0, 0xd3],
    createWasmCpuStateSnapshot({
      ebx: 0xaaaa_0000,
      ...cfOfSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(carryClear.exit);
  strictEqual(carryClear.state.ebx, 0xaaaa_0000);
  assertCompletedInstruction(carryClear.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(carryClear.state), { ...preservedFlags, CF: 1, OF: 1 });

  assertSingleInstructionExit(carrySet.exit);
  strictEqual(carrySet.state.ebx, 0xaaaa_0001);
  assertCompletedInstruction(carrySet.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(carrySet.state), { ...preservedFlags, CF: 0, OF: 0 });
});

test("executes RCR with old carry clear and set", async () => {
  const carryClear = await executeInstruction(
    [0xd1, 0xd8],
    createWasmCpuStateSnapshot({
      eax: 1,
      ...cfOfClear,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const carrySet = await executeInstruction(
    [0xd1, 0xd8],
    createWasmCpuStateSnapshot({
      eax: 0,
      ...cfOfSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(carryClear.exit);
  strictEqual(carryClear.state.eax, 0);
  assertCompletedInstruction(carryClear.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(carryClear.state), { ...preservedFlags, CF: 1, OF: 0 });

  assertSingleInstructionExit(carrySet.exit);
  strictEqual(carrySet.state.eax, 0x8000_0000);
  assertCompletedInstruction(carrySet.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(carrySet.state), { ...preservedFlags, CF: 0, OF: 1 });
});

test("RCL through-carry full-cycle count preserves value and CF but clears OF", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xaaaa_0012,
    ...cfOfSet,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0xc0, 0xd0, 0x09], initialState);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_0012);
  assertCompletedInstruction(state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { ...preservedFlags, CF: 1, OF: 0 });
});

test("faulting rotate memory destination leaves state and flags unchanged", async () => {
  const faultAddress = 0x1_0000;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    ebx: faultAddress,
    ...cfOfSet,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0xd1, 0x03], initialState);

  deepStrictEqual(exit, writePageFaultExit(faultAddress));
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.ebx, initialState.ebx);
  assertCompletedInstruction(state, startAddress, 7);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), cfOfSet);
});
