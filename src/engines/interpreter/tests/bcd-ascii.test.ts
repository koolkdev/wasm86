import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  createWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf
} from "#runtime/tests/fixtures/cpu-state.js";
import { startAddress } from "#wasm/tests/helpers.js";
import { divideErrorExit } from "#wasm/tests/exit-fixtures.js";
import { assertCompletedInstruction, assertSingleInstructionExit, executeInstruction } from "./support.js";

test("executes DAA with low and high decimal adjustment", async () => {
  const { exit, state } = await executeInstruction(
    [0x27],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_009a,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_0000);
  assertCompletedInstruction(state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 0, OF: 0 });
});

test("executes DAS with incoming carry adjustment", async () => {
  const { exit, state } = await executeInstruction(
    [0x2f],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_0080,
      CF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_0020);
  assertCompletedInstruction(state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 1, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 });
});

test("DAS sets carry when the low decimal adjustment borrows", async () => {
  const { exit, state } = await executeInstruction(
    [0x2f],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_0000,
      AF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_00fa);
  assertCompletedInstruction(state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 1, PF: 1, AF: 1, ZF: 0, SF: 1, OF: 0 });
});

test("executes AAA and updates observed undefined flags from final AL", async () => {
  const { exit, state } = await executeInstruction(
    [0x37],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_120a,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_1300);
  assertCompletedInstruction(state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 0, OF: 0 });
});

test("AAA applies carry from AL into AH during AX adjustment", async () => {
  const { exit, state } = await executeInstruction(
    [0x37],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_12fa,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_1400);
  assertCompletedInstruction(state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 0, OF: 0 });
});

test("executes AAS and updates observed undefined flags from final AL", async () => {
  const { exit, state } = await executeInstruction(
    [0x3f],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_120a,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_1104);
  assertCompletedInstruction(state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 1, PF: 0, AF: 1, ZF: 0, SF: 0, OF: 0 });
});

test("AAS applies borrow from AL into AH during AX adjustment", async () => {
  const { exit, state } = await executeInstruction(
    [0x3f],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_1200,
      AF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xaaaa_100a);
  assertCompletedInstruction(state, startAddress + 1, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 1, PF: 1, AF: 1, ZF: 0, SF: 0, OF: 0 });
});

test("executes AAM imm8 with decimal and non-decimal bases", async () => {
  const decimal = await executeInstruction(
    [0xd4, 0x0a],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_7763,
      CF: 1,
      AF: 1,
      OF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const binary = await executeInstruction(
    [0xd4, 0x02],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_77ff,
      CF: 1,
      AF: 1,
      OF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(decimal.exit);
  strictEqual(decimal.state.eax, 0xaaaa_0909);
  assertCompletedInstruction(decimal.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(decimal.state), { CF: 0, PF: 1, AF: 0, ZF: 0, SF: 0, OF: 0 });

  assertSingleInstructionExit(binary.exit);
  strictEqual(binary.state.eax, 0xaaaa_7f01);
  assertCompletedInstruction(binary.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(binary.state), { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 });
});

test("AAM base zero raises divide error without changing architectural state", async () => {
  const { exit, state } = await executeInstruction(
    [0xd4, 0x00],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_1234,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );

  deepStrictEqual(exit, divideErrorExit());
  strictEqual(state.eax, 0xaaaa_1234);
  strictEqual(state.eip, startAddress);
  strictEqual(state.instructionCount, 7);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 });
});

test("executes AAD imm8 with internal add flag behavior", async () => {
  const auxCarry = await executeInstruction(
    [0xd5, 0x0a],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_010f,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );
  const overflow = await executeInstruction(
    [0xd5, 0x80],
    createWasmCpuStateSnapshot({
      eax: 0xaaaa_0180,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(auxCarry.exit);
  strictEqual(auxCarry.state.eax, 0xaaaa_0019);
  assertCompletedInstruction(auxCarry.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(auxCarry.state), { CF: 0, PF: 0, AF: 1, ZF: 0, SF: 0, OF: 0 });

  assertSingleInstructionExit(overflow.exit);
  strictEqual(overflow.state.eax, 0xaaaa_0000);
  assertCompletedInstruction(overflow.state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(overflow.state), { CF: 1, PF: 1, AF: 0, ZF: 1, SF: 0, OF: 1 });
});
