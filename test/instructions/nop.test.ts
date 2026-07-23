import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { runCompiledInstructions } from "#test/instructions/harness/compiled-instruction.js";
import { startAddress } from "#test/support/addresses.js";
import {
  createWasmCpuArchitecturalStateSnapshot
} from "#test/support/cpu-state.js";

const allFlagsSet = {
  CF: 1,
  PF: 1,
  AF: 1,
  ZF: 1,
  SF: 1,
  OF: 1,
  TF: 1,
  DF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

type NopCase = Readonly<{
  name: string;
  bytes: readonly number[];
}>;

const nopCases: readonly NopCase[] = [
  {
    name: "90 single-byte NOP",
    bytes: [0x90]
  },
  {
    name: "66 90 operand-size-prefixed NOP",
    bytes: [0x66, 0x90]
  },
  {
    name: "0F 1F ignores an out-of-range effective address",
    bytes: [0x0f, 0x1f, 0x80, 0xff, 0xff, 0xff, 0x7f]
  },
  {
    name: "66 0F 1F multi-byte NOP",
    bytes: [0x66, 0x0f, 0x1f, 0x00]
  }
];

for (const entry of nopCases) {
  test(`${entry.name} has no architectural or guest-data effect`, async () => {
    await assertNopCase(entry);
  });
}

async function assertNopCase(entry: NopCase): Promise<void> {
  const address = 0x3000;
  const initialBytes = [0xaa, 0xbb, 0xcc, 0xdd];
  const initialState = createWasmCpuArchitecturalStateSnapshot({
    eax: 0x1_0000,
    ebx: 0x1234_5678,
    ...allFlagsSet,
    eip: startAddress,
    instructionCount: 7
  });
  const result = await runCompiledInstructions({
    bytes: entry.bytes,
    initialState,
    memoryPatches: [{ address, bytes: initialBytes }],
    memoryRanges: [{ address, byteLength: initialBytes.length }]
  });

  deepStrictEqual(
    result.completion,
    {
      kind: "completed",
      targetEip: startAddress + entry.bytes.length
    },
    entry.name
  );
  deepStrictEqual(
    result.state,
    {
      ...initialState,
      eip: startAddress + entry.bytes.length,
      instructionCount: initialState.instructionCount + 1
    },
    entry.name
  );
  deepStrictEqual(
    result.memory,
    [{ address, byteLength: initialBytes.length, bytes: initialBytes }],
    entry.name
  );
}
