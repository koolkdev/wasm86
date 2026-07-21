import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  createWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf
} from "#test/support/cpu-state.js";
import { startAddress } from "#test/support/addresses.js";
import { assertCompletedInstruction, assertSingleInstructionExit, executeInstruction } from "./harness.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

test("executes CBW without modifying flags or high EAX bits", async () => {
  const positive = await executeInstruction(
    [0x66, 0x98],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_007f,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const negative = await executeInstruction(
    [0x66, 0x98],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_0080,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(positive.exit);
  strictEqual(positive.state.eax, 0xaaaa_007f);
  assertCompletedInstruction(positive.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(positive.state), allFlagsSet);

  assertSingleInstructionExit(negative.exit);
  strictEqual(negative.state.eax, 0xaaaa_ff80);
  assertCompletedInstruction(negative.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(negative.state), allFlagsSet);
});

test("executes CWDE without modifying flags", async () => {
  const positive = await executeInstruction(
    [0x98],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_7fff,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const negative = await executeInstruction(
    [0x98],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_8000,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(positive.exit);
  strictEqual(positive.state.eax, 0x0000_7fff);
  assertCompletedInstruction(positive.state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(positive.state), allFlagsSet);

  assertSingleInstructionExit(negative.exit);
  strictEqual(negative.state.eax, 0xffff_8000);
  assertCompletedInstruction(negative.state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(negative.state), allFlagsSet);
});

test("executes CWD without modifying flags or high EDX bits", async () => {
  const positive = await executeInstruction(
    [0x66, 0x99],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_7fff,
      edx: 0xbbbb_1234,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const negative = await executeInstruction(
    [0x66, 0x99],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_8000,
      edx: 0xbbbb_1234,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(positive.exit);
  strictEqual(positive.state.eax, 0xaaaa_7fff);
  strictEqual(positive.state.edx, 0xbbbb_0000);
  assertCompletedInstruction(positive.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(positive.state), allFlagsSet);

  assertSingleInstructionExit(negative.exit);
  strictEqual(negative.state.eax, 0xaaaa_8000);
  strictEqual(negative.state.edx, 0xbbbb_ffff);
  assertCompletedInstruction(negative.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(negative.state), allFlagsSet);
});

test("executes CDQ without modifying flags", async () => {
  const positive = await executeInstruction(
    [0x99],
    createWasmCpuStateSnapshot({
      eax: 0x7fff_ffff,
      edx: 0x1234_5678,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const negative = await executeInstruction(
    [0x99],
    createWasmCpuStateSnapshot({
      eax: 0x8000_0000,
      edx: 0x1234_5678,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(positive.exit);
  strictEqual(positive.state.eax, 0x7fff_ffff);
  strictEqual(positive.state.edx, 0);
  assertCompletedInstruction(positive.state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(positive.state), allFlagsSet);

  assertSingleInstructionExit(negative.exit);
  strictEqual(negative.state.eax, 0x8000_0000);
  strictEqual(negative.state.edx, 0xffff_ffff);
  assertCompletedInstruction(negative.state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(negative.state), allFlagsSet);
});
