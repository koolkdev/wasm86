import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import { runCompiledInstructions } from "#test/instructions/harness/compiled-instruction.js";
import {
  assertInstructionCase,
  type InstructionCase
} from "#test/instructions/harness/instruction-case.js";
import { startAddress } from "#test/support/addresses.js";
import { createWasmCpuArchitecturalStateSnapshot } from "#test/support/cpu-state.js";

const sourceAddress = 0x100;
const destinationAddress = 0x200;

const preservedFlags = {
  CF: 1,
  PF: 0,
  AF: 1,
  ZF: 0,
  SF: 1,
  OF: 0,
  TF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

const compareInitialFlags = {
  CF: 1,
  PF: 0,
  AF: 1,
  ZF: 0,
  SF: 1,
  OF: 1,
  TF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

const mismatchFlags = {
  CF: 1,
  PF: 1,
  AF: 1,
  ZF: 0,
  SF: 1,
  OF: 0
} as const;

const equalFlags = {
  CF: 0,
  PF: 1,
  AF: 0,
  ZF: 1,
  SF: 0,
  OF: 0
} as const;

const repetitionCases = [
  {
    name: "REP MOVSD copies every dword forward and counts completed units",
    bytes: [0xf3, 0xa5],
    initialState: {
      ecx: 3,
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { ecx: 0, esi: 0x10c, edi: 0x20c },
    instructionCount: 3,
    memoryPatches: [
      {
        address: sourceAddress,
        bytes: [
          0x22, 0x22, 0x11, 0x11,
          0x44, 0x44, 0x33, 0x33,
          0x66, 0x66, 0x55, 0x55
        ]
      },
      {
        address: destinationAddress - 1,
        bytes: [
          0xaa,
          0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00,
          0xbb
        ]
      }
    ],
    expectedMemory: [
      {
        address: destinationAddress - 1,
        bytes: [
          0xaa,
          0x22, 0x22, 0x11, 0x11,
          0x44, 0x44, 0x33, 0x33,
          0x66, 0x66, 0x55, 0x55,
          0xbb
        ]
      }
    ]
  },
  {
    name: "REP MOVSD copies every dword backward when DF is set",
    bytes: [0xf3, 0xa5],
    initialState: {
      ecx: 3,
      esi: 0x108,
      edi: 0x208,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { ecx: 0, esi: 0xfc, edi: 0x1fc },
    instructionCount: 3,
    memoryPatches: [
      {
        address: sourceAddress,
        bytes: [
          0x22, 0x22, 0x11, 0x11,
          0x44, 0x44, 0x33, 0x33,
          0x66, 0x66, 0x55, 0x55
        ]
      },
      {
        address: destinationAddress,
        bytes: [
          0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00
        ]
      }
    ],
    expectedMemory: [
      {
        address: destinationAddress,
        bytes: [
          0x22, 0x22, 0x11, 0x11,
          0x44, 0x44, 0x33, 0x33,
          0x66, 0x66, 0x55, 0x55
        ]
      }
    ]
  },
  {
    name: "REP STOSB stores AL once per element",
    bytes: [0xf3, 0xaa],
    initialState: {
      eax: 0x1122_335a,
      ecx: 3,
      esi: 0x345,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { ecx: 0, edi: 0x203 },
    instructionCount: 3,
    memoryPatches: [
      { address: destinationAddress - 1, bytes: [0xaa, 0x00, 0x00, 0x00, 0xbb] }
    ],
    expectedMemory: [
      { address: destinationAddress - 1, bytes: [0xaa, 0x5a, 0x5a, 0x5a, 0xbb] }
    ]
  },
  {
    name: "REP LODSW walks backward and leaves the last loaded word in AX",
    bytes: [0xf3, 0x66, 0xad],
    initialState: {
      eax: 0xaaaa_0000,
      ecx: 3,
      esi: 0x104,
      edi: 0x456,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { eax: 0xaaaa_1111, ecx: 0, esi: 0xfe },
    instructionCount: 3,
    memoryPatches: [
      { address: sourceAddress, bytes: [0x11, 0x11, 0x22, 0x22, 0x33, 0x33] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0x11, 0x11, 0x22, 0x22, 0x33, 0x33] }
    ]
  },
  {
    name: "the last REP prefix replaces an earlier REPNE prefix",
    bytes: [0xf2, 0xf3, 0xa5],
    initialState: {
      ecx: 2,
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { ecx: 0, esi: 0x108, edi: 0x208 },
    instructionCount: 2,
    memoryPatches: [
      {
        address: sourceAddress,
        bytes: [0x22, 0x22, 0x11, 0x11, 0x44, 0x44, 0x33, 0x33]
      }
    ],
    expectedMemory: [
      {
        address: destinationAddress,
        bytes: [0x22, 0x22, 0x11, 0x11, 0x44, 0x44, 0x33, 0x33]
      }
    ]
  },
  {
    name: "operand-size before REP selects REP MOVSW",
    bytes: [0x66, 0xf3, 0xa5],
    initialState: {
      ecx: 3,
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { ecx: 0, esi: 0x106, edi: 0x206 },
    instructionCount: 3,
    memoryPatches: [
      { address: sourceAddress, bytes: [0x22, 0x11, 0x44, 0x33, 0x66, 0x55] }
    ],
    expectedMemory: [
      { address: destinationAddress, bytes: [0x22, 0x11, 0x44, 0x33, 0x66, 0x55] }
    ]
  },
  {
    name: "REP before operand-size also selects REP MOVSW",
    bytes: [0xf3, 0x66, 0xa5],
    initialState: {
      ecx: 3,
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { ecx: 0, esi: 0x106, edi: 0x206 },
    instructionCount: 3,
    memoryPatches: [
      { address: sourceAddress, bytes: [0x22, 0x11, 0x44, 0x33, 0x66, 0x55] }
    ],
    expectedMemory: [
      { address: destinationAddress, bytes: [0x22, 0x11, 0x44, 0x33, 0x66, 0x55] }
    ]
  },
  {
    name: "REPE CMPSB stops after the first mismatch and exposes that comparison",
    bytes: [0xf3, 0xa6],
    initialState: {
      ecx: 4,
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...compareInitialFlags
    },
    expectedState: {
      ecx: 1,
      esi: 0x103,
      edi: 0x203,
      ...mismatchFlags
    },
    instructionCount: 3,
    memoryPatches: [
      { address: sourceAddress, bytes: [0x01, 0x02, 0x03, 0x04] },
      { address: destinationAddress, bytes: [0x01, 0x02, 0x09, 0x04] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0x01, 0x02, 0x03, 0x04] },
      { address: destinationAddress, bytes: [0x01, 0x02, 0x09, 0x04] }
    ]
  },
  {
    name: "REPNE SCASB stops after the first match and exposes that comparison",
    bytes: [0xf2, 0xae],
    initialState: {
      eax: 0x1122_3303,
      ecx: 4,
      esi: 0x345,
      edi: destinationAddress,
      DF: 0,
      ...compareInitialFlags
    },
    expectedState: {
      ecx: 1,
      edi: 0x203,
      ...equalFlags
    },
    instructionCount: 3,
    memoryPatches: [
      { address: destinationAddress, bytes: [0x01, 0x02, 0x03, 0x04] }
    ],
    expectedMemory: [
      { address: destinationAddress, bytes: [0x01, 0x02, 0x03, 0x04] }
    ]
  }
] as const satisfies readonly InstructionCase[];

for (const entry of repetitionCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("REP MOVSD with zero ECX completes without touching invalid source or destination addresses", async () => {
  await assertInstructionCase({
    name: "REP MOVSD zero trip",
    bytes: [0xf3, 0xa5],
    initialState: {
      ecx: 0,
      esi: guestMemoryMinimumByteLength,
      edi: guestMemoryMinimumByteLength,
      DF: 0,
      ...preservedFlags
    },
    expectedState: {
      ecx: 0,
      esi: guestMemoryMinimumByteLength,
      edi: guestMemoryMinimumByteLength
    }
  });
});

test("a pending zero loaded into ECX still takes the REP MOVSD zero-trip path", async () => {
  await assertInstructionCase({
    name: "dirty ECX REP MOVSD zero trip",
    bytes: [
      0x8b, 0x0d, 0x50, 0x00, 0x00, 0x00,
      0xf3, 0xa5
    ],
    initialState: {
      ecx: 5,
      esi: guestMemoryMinimumByteLength,
      edi: guestMemoryMinimumByteLength,
      DF: 0,
      ...preservedFlags
    },
    expectedState: {
      ecx: 0,
      esi: guestMemoryMinimumByteLength,
      edi: guestMemoryMinimumByteLength
    },
    instructionCount: 2,
    memoryPatches: [{ address: 0x50, bytes: [0x00, 0x00, 0x00, 0x00] }],
    expectedMemory: [{ address: 0x50, bytes: [0x00, 0x00, 0x00, 0x00] }]
  });
});

test("a REP MOVSD write fault keeps the completed unit and rolls back the faulting unit", async () => {
  await assertInstructionCase({
    name: "REP MOVSD destination fault progress",
    bytes: [0xf3, 0xa5],
    initialState: {
      ecx: 2,
      esi: sourceAddress,
      edi: guestMemoryMinimumByteLength - 4,
      DF: 0,
      ...preservedFlags
    },
    expectedState: {
      ecx: 1,
      esi: 0x104,
      edi: guestMemoryMinimumByteLength
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 2
      }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [
      {
        address: sourceAddress,
        bytes: [0x22, 0x22, 0x11, 0x11, 0x44, 0x44, 0x33, 0x33]
      },
      {
        address: guestMemoryMinimumByteLength - 4,
        bytes: [0xaa, 0xaa, 0xaa, 0xaa]
      }
    ],
    expectedMemory: [
      {
        address: sourceAddress,
        bytes: [0x22, 0x22, 0x11, 0x11, 0x44, 0x44, 0x33, 0x33]
      },
      {
        address: guestMemoryMinimumByteLength - 4,
        bytes: [0x22, 0x22, 0x11, 0x11]
      }
    ]
  });
});

test("a REPE CMPSD fault preserves the last completed comparison and discards the current one", async () => {
  await assertInstructionCase({
    name: "REPE CMPSD source-first fault progress",
    bytes: [0xf3, 0xa7],
    initialState: {
      ecx: 2,
      esi: guestMemoryMinimumByteLength - 4,
      edi: guestMemoryMinimumByteLength - 5,
      DF: 0,
      ...compareInitialFlags
    },
    expectedState: {
      ecx: 1,
      esi: guestMemoryMinimumByteLength,
      edi: guestMemoryMinimumByteLength - 1,
      ...equalFlags
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 0
      }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [
      {
        address: guestMemoryMinimumByteLength - 5,
        bytes: [0x11, 0x11, 0x11, 0x11, 0x11]
      }
    ],
    expectedMemory: [
      {
        address: guestMemoryMinimumByteLength - 5,
        bytes: [0x11, 0x11, 0x11, 0x11, 0x11]
      }
    ]
  });
});

test("retrying REP MOVSD resumes from committed progress after source translation is repaired", async () => {
  const bytes = [0x64, 0xf3, 0xa5] as const;
  const first = await assertInstructionCase({
    name: "REP MOVSD retry first run",
    bytes,
    initialState: {
      ecx: 2,
      esi: sourceAddress,
      edi: 0x300,
      fsBase: 0xfefc,
      DF: 0,
      ...preservedFlags
    },
    expectedState: {
      ecx: 1,
      esi: 0x104,
      edi: 0x304
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 0
      }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [
      {
        address: guestMemoryMinimumByteLength - 4,
        bytes: [0x22, 0x22, 0x11, 0x11]
      },
      {
        address: 0x300,
        bytes: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
      }
    ],
    expectedMemory: [
      {
        address: guestMemoryMinimumByteLength - 4,
        bytes: [0x22, 0x22, 0x11, 0x11]
      },
      {
        address: 0x300,
        bytes: [0x22, 0x22, 0x11, 0x11, 0x00, 0x00, 0x00, 0x00]
      }
    ]
  });
  const resumed = await runCompiledInstructions({
    bytes,
    initialState: {
      ...first.state,
      fsBase: 0x1000
    },
    memoryPatches: [
      {
        address: 0x300,
        bytes: [0x22, 0x22, 0x11, 0x11, 0x00, 0x00, 0x00, 0x00]
      },
      { address: 0x1104, bytes: [0x44, 0x44, 0x33, 0x33] }
    ],
    memoryRanges: [{ address: 0x300, byteLength: 8 }]
  });

  deepStrictEqual(resumed.completion, {
    kind: "completed",
    targetEip: startAddress + bytes.length
  });
  deepStrictEqual(
    resumed.state,
    createWasmCpuArchitecturalStateSnapshot({
      ...first.state,
      ecx: 0,
      esi: 0x108,
      edi: 0x308,
      fsBase: 0x1000,
      eip: startAddress + bytes.length,
      instructionCount: 8
    })
  );
  deepStrictEqual(resumed.memory, [
    {
      address: 0x300,
      byteLength: 8,
      bytes: [
        0x22, 0x22, 0x11, 0x11,
        0x44, 0x44, 0x33, 0x33
      ]
    }
  ]);
});
