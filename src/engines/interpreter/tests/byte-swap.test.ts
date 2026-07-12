import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  createWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf
} from "#test/support/cpu-state.js";
import { startAddress } from "#test/support/addresses.js";
import { assertCompletedInstruction, assertSingleInstructionExit, executeInstruction } from "./support.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

test("executes BSWAP r32 without modifying flags", async () => {
  const { exit, state } = await executeInstruction(
    [0x0f, 0xcb],
    createWasmCpuStateSnapshot({
      ebx: 0x1234_5678,
      ...allFlagsSet,
      eip: startAddress,
      instructionCount: 7
    })
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.ebx, 0x7856_3412);
  assertCompletedInstruction(state, startAddress + 2, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), allFlagsSet);
});
