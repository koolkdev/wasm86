import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { runCompiledInstructions } from "#test/instructions/harness/compiled-instruction.js";
import { startAddress } from "#test/support/addresses.js";
import {
  createWasmCpuArchitecturalStateSnapshot,
  type WasmCpuArchitecturalStateInit
} from "#test/support/cpu-state.js";

const preservedState = {
  eax: 0x1234_5678,
  ebx: 0x89ab_cdef,
  CF: 1,
  PF: 0,
  AF: 1,
  ZF: 0,
  SF: 1,
  OF: 0,
  TF: 1,
  DF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

type FlagCase = Readonly<{
  name: string;
  bytes: readonly number[];
  initialState: WasmCpuArchitecturalStateInit;
  expectedState: WasmCpuArchitecturalStateInit;
  instructionCount?: number;
}>;

const carryControlCases: readonly FlagCase[] = [
  {
    name: "F8 CLC clears CF",
    bytes: [0xf8],
    initialState: { CF: 1 },
    expectedState: { CF: 0 }
  },
  {
    name: "F9 STC sets CF",
    bytes: [0xf9],
    initialState: { CF: 0 },
    expectedState: { CF: 1 }
  },
  {
    name: "F5 CMC complements a clear CF",
    bytes: [0xf5],
    initialState: { CF: 0 },
    expectedState: { CF: 1 }
  },
  {
    name: "F5 CMC complements a set CF",
    bytes: [0xf5],
    initialState: { CF: 1 },
    expectedState: { CF: 0 }
  },
  {
    name: "CMC complements carry produced by the preceding ADD",
    bytes: [0x83, 0xc0, 0x01, 0xf5],
    initialState: { eax: 0xffff_ffff, CF: 0 },
    expectedState: {
      eax: 0,
      CF: 0,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 0,
      OF: 0
    },
    instructionCount: 2
  }
];

const directionControlCases: readonly FlagCase[] = [
  {
    name: "FC CLD clears DF",
    bytes: [0xfc],
    initialState: { DF: 1 },
    expectedState: { DF: 0 }
  },
  {
    name: "FD STD sets DF",
    bytes: [0xfd],
    initialState: { DF: 0 },
    expectedState: { DF: 1 }
  }
];

const lahfCases: readonly FlagCase[] = [
  {
    name: "9F LAHF emits only the fixed low-image bit when status flags are clear",
    bytes: [0x9f],
    initialState: {
      eax: 0x1234_5678,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 1
    },
    expectedState: { eax: 0x1234_0278 }
  },
  {
    name: "9F LAHF emits the complete low status image",
    bytes: [0x9f],
    initialState: {
      eax: 0x1234_5678,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 0
    },
    expectedState: { eax: 0x1234_d778 }
  },
  {
    name: "9F LAHF emits an alternating low status image",
    bytes: [0x9f],
    initialState: {
      eax: 0x1234_5678,
      CF: 1,
      PF: 0,
      AF: 1,
      ZF: 0,
      SF: 1,
      OF: 1
    },
    expectedState: { eax: 0x1234_9378 }
  }
];

const sahfCases: readonly FlagCase[] = [
  {
    name: "9E SAHF consumes all five modeled AH image bits",
    bytes: [0x9e],
    initialState: {
      eax: 0x1234_ff78,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 1
    },
    expectedState: {
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 1
    }
  },
  {
    name: "9E SAHF ignores reserved AH image bits",
    bytes: [0x9e],
    initialState: {
      eax: 0x1234_2a78,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1
    },
    expectedState: {
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0
    }
  },
  {
    name: "9E 9F SAHF and LAHF round-trip the low flag image",
    bytes: [0x9e, 0x9f],
    initialState: {
      eax: 0x1234_6f00,
      CF: 0,
      PF: 0,
      AF: 1,
      ZF: 0,
      SF: 1,
      OF: 1
    },
    expectedState: {
      eax: 0x1234_4700,
      CF: 1,
      PF: 1,
      AF: 0,
      ZF: 1,
      SF: 0
    },
    instructionCount: 2
  }
];

for (const entry of [
  ...carryControlCases,
  ...directionControlCases,
  ...lahfCases,
  ...sahfCases
]) {
  test(entry.name, async () => {
    await assertFlagCase(entry);
  });
}

async function assertFlagCase(entry: FlagCase): Promise<void> {
  const instructionCount = entry.instructionCount ?? 1;
  const initialState = createWasmCpuArchitecturalStateSnapshot({
    ...preservedState,
    eip: startAddress,
    instructionCount: 7,
    ...entry.initialState
  });
  const result = await runCompiledInstructions({
    bytes: entry.bytes,
    initialState
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
      ...entry.expectedState,
      eip: startAddress + entry.bytes.length,
      instructionCount: initialState.instructionCount + instructionCount
    },
    entry.name
  );
  deepStrictEqual(result.memory, [], entry.name);
}
