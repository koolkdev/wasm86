import { test } from "node:test";

import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import {
  assertInstructionCase,
  type InstructionCase
} from "#test/instructions/harness/instruction-case.js";

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
  AF: 0,
  ZF: 1,
  SF: 0,
  OF: 0,
  TF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

const byteCompareFlags = {
  CF: 0,
  PF: 0,
  AF: 1,
  ZF: 0,
  SF: 0,
  OF: 1
} as const;

const wordCompareFlags = {
  CF: 1,
  PF: 1,
  AF: 0,
  ZF: 0,
  SF: 1,
  OF: 1
} as const;

const dwordCompareFlags = {
  CF: 0,
  PF: 1,
  AF: 1,
  ZF: 0,
  SF: 0,
  OF: 1
} as const;

const oneShotCases = [
  {
    name: "MOVSB copies one byte and increments both indexes when DF is clear",
    bytes: [0xa4],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { esi: 0x101, edi: 0x201 },
    memoryPatches: [
      { address: sourceAddress, bytes: [0x7c] },
      { address: destinationAddress - 1, bytes: [0xaa, 0x00, 0xbb] }
    ],
    expectedMemory: [
      { address: destinationAddress - 1, bytes: [0xaa, 0x7c, 0xbb] }
    ]
  },
  {
    name: "MOVSB copies one byte and decrements both indexes when DF is set",
    bytes: [0xa4],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { esi: 0xff, edi: 0x1ff },
    memoryPatches: [
      { address: sourceAddress, bytes: [0x7c] },
      { address: destinationAddress - 1, bytes: [0xaa, 0x00, 0xbb] }
    ],
    expectedMemory: [
      { address: destinationAddress - 1, bytes: [0xaa, 0x7c, 0xbb] }
    ]
  },
  {
    name: "MOVSW copies one word and increments both indexes by two",
    bytes: [0x66, 0xa5],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { esi: 0x102, edi: 0x202 },
    memoryPatches: [
      { address: sourceAddress, bytes: [0xef, 0xbe] },
      { address: destinationAddress - 1, bytes: [0xaa, 0x00, 0x00, 0xbb] }
    ],
    expectedMemory: [
      { address: destinationAddress - 1, bytes: [0xaa, 0xef, 0xbe, 0xbb] }
    ]
  },
  {
    name: "MOVSW copies one word and decrements both indexes by two",
    bytes: [0x66, 0xa5],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { esi: 0xfe, edi: 0x1fe },
    memoryPatches: [
      { address: sourceAddress, bytes: [0xef, 0xbe] },
      { address: destinationAddress - 1, bytes: [0xaa, 0x00, 0x00, 0xbb] }
    ],
    expectedMemory: [
      { address: destinationAddress - 1, bytes: [0xaa, 0xef, 0xbe, 0xbb] }
    ]
  },
  {
    name: "MOVSD copies one dword and increments both indexes by four",
    bytes: [0xa5],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { esi: 0x104, edi: 0x204 },
    memoryPatches: [
      { address: sourceAddress, bytes: [0xbe, 0xba, 0xfe, 0xca] },
      {
        address: destinationAddress - 1,
        bytes: [0xaa, 0x00, 0x00, 0x00, 0x00, 0xbb]
      }
    ],
    expectedMemory: [
      {
        address: destinationAddress - 1,
        bytes: [0xaa, 0xbe, 0xba, 0xfe, 0xca, 0xbb]
      }
    ]
  },
  {
    name: "MOVSD copies one dword and decrements both indexes by four",
    bytes: [0xa5],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { esi: 0xfc, edi: 0x1fc },
    memoryPatches: [
      { address: sourceAddress, bytes: [0xbe, 0xba, 0xfe, 0xca] },
      {
        address: destinationAddress - 1,
        bytes: [0xaa, 0x00, 0x00, 0x00, 0x00, 0xbb]
      }
    ],
    expectedMemory: [
      {
        address: destinationAddress - 1,
        bytes: [0xaa, 0xbe, 0xba, 0xfe, 0xca, 0xbb]
      }
    ]
  },
  {
    name: "STOSB stores AL and increments EDI when DF is clear",
    bytes: [0xaa],
    initialState: {
      eax: 0x1122_337c,
      esi: 0x345,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { edi: 0x201 },
    memoryPatches: [
      { address: destinationAddress - 1, bytes: [0xaa, 0x00, 0xbb] }
    ],
    expectedMemory: [
      { address: destinationAddress - 1, bytes: [0xaa, 0x7c, 0xbb] }
    ]
  },
  {
    name: "STOSB stores AL and decrements EDI when DF is set",
    bytes: [0xaa],
    initialState: {
      eax: 0x1122_337c,
      esi: 0x345,
      edi: destinationAddress,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { edi: 0x1ff },
    memoryPatches: [
      { address: destinationAddress - 1, bytes: [0xaa, 0x00, 0xbb] }
    ],
    expectedMemory: [
      { address: destinationAddress - 1, bytes: [0xaa, 0x7c, 0xbb] }
    ]
  },
  {
    name: "STOSW stores AX and increments EDI by two",
    bytes: [0x66, 0xab],
    initialState: {
      eax: 0x1122_beef,
      esi: 0x345,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { edi: 0x202 },
    memoryPatches: [
      { address: destinationAddress - 1, bytes: [0xaa, 0x00, 0x00, 0xbb] }
    ],
    expectedMemory: [
      { address: destinationAddress - 1, bytes: [0xaa, 0xef, 0xbe, 0xbb] }
    ]
  },
  {
    name: "STOSW stores AX and decrements EDI by two",
    bytes: [0x66, 0xab],
    initialState: {
      eax: 0x1122_beef,
      esi: 0x345,
      edi: destinationAddress,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { edi: 0x1fe },
    memoryPatches: [
      { address: destinationAddress - 1, bytes: [0xaa, 0x00, 0x00, 0xbb] }
    ],
    expectedMemory: [
      { address: destinationAddress - 1, bytes: [0xaa, 0xef, 0xbe, 0xbb] }
    ]
  },
  {
    name: "STOSD stores EAX and increments EDI by four",
    bytes: [0xab],
    initialState: {
      eax: 0xcafe_babe,
      esi: 0x345,
      edi: destinationAddress,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { edi: 0x204 },
    memoryPatches: [
      {
        address: destinationAddress - 1,
        bytes: [0xaa, 0x00, 0x00, 0x00, 0x00, 0xbb]
      }
    ],
    expectedMemory: [
      {
        address: destinationAddress - 1,
        bytes: [0xaa, 0xbe, 0xba, 0xfe, 0xca, 0xbb]
      }
    ]
  },
  {
    name: "STOSD stores EAX and decrements EDI by four",
    bytes: [0xab],
    initialState: {
      eax: 0xcafe_babe,
      esi: 0x345,
      edi: destinationAddress,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { edi: 0x1fc },
    memoryPatches: [
      {
        address: destinationAddress - 1,
        bytes: [0xaa, 0x00, 0x00, 0x00, 0x00, 0xbb]
      }
    ],
    expectedMemory: [
      {
        address: destinationAddress - 1,
        bytes: [0xaa, 0xbe, 0xba, 0xfe, 0xca, 0xbb]
      }
    ]
  },
  {
    name: "LODSB loads AL, preserves upper EAX, and increments ESI",
    bytes: [0xac],
    initialState: {
      eax: 0x1122_3344,
      esi: sourceAddress,
      edi: 0x456,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { eax: 0x1122_337c, esi: 0x101 },
    memoryPatches: [{ address: sourceAddress, bytes: [0x7c] }],
    expectedMemory: [{ address: sourceAddress, bytes: [0x7c] }]
  },
  {
    name: "LODSB loads AL, preserves upper EAX, and decrements ESI",
    bytes: [0xac],
    initialState: {
      eax: 0x1122_3344,
      esi: sourceAddress,
      edi: 0x456,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { eax: 0x1122_337c, esi: 0xff },
    memoryPatches: [{ address: sourceAddress, bytes: [0x7c] }],
    expectedMemory: [{ address: sourceAddress, bytes: [0x7c] }]
  },
  {
    name: "LODSW loads AX, preserves upper EAX, and increments ESI by two",
    bytes: [0x66, 0xad],
    initialState: {
      eax: 0x1122_3344,
      esi: sourceAddress,
      edi: 0x456,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { eax: 0x1122_beef, esi: 0x102 },
    memoryPatches: [{ address: sourceAddress, bytes: [0xef, 0xbe] }],
    expectedMemory: [{ address: sourceAddress, bytes: [0xef, 0xbe] }]
  },
  {
    name: "LODSW loads AX, preserves upper EAX, and decrements ESI by two",
    bytes: [0x66, 0xad],
    initialState: {
      eax: 0x1122_3344,
      esi: sourceAddress,
      edi: 0x456,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { eax: 0x1122_beef, esi: 0xfe },
    memoryPatches: [{ address: sourceAddress, bytes: [0xef, 0xbe] }],
    expectedMemory: [{ address: sourceAddress, bytes: [0xef, 0xbe] }]
  },
  {
    name: "LODSD loads EAX and increments ESI by four",
    bytes: [0xad],
    initialState: {
      eax: 0x1122_3344,
      esi: sourceAddress,
      edi: 0x456,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { eax: 0xcafe_babe, esi: 0x104 },
    memoryPatches: [
      { address: sourceAddress, bytes: [0xbe, 0xba, 0xfe, 0xca] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0xbe, 0xba, 0xfe, 0xca] }
    ]
  },
  {
    name: "LODSD loads EAX and decrements ESI by four",
    bytes: [0xad],
    initialState: {
      eax: 0x1122_3344,
      esi: sourceAddress,
      edi: 0x456,
      DF: 1,
      ...preservedFlags
    },
    expectedState: { eax: 0xcafe_babe, esi: 0xfc },
    memoryPatches: [
      { address: sourceAddress, bytes: [0xbe, 0xba, 0xfe, 0xca] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0xbe, 0xba, 0xfe, 0xca] }
    ]
  },
  {
    name: "CMPSB subtracts the ES byte from the source byte and increments indexes",
    bytes: [0xa6],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...compareInitialFlags
    },
    expectedState: {
      esi: 0x101,
      edi: 0x201,
      ...byteCompareFlags
    },
    memoryPatches: [
      { address: sourceAddress, bytes: [0x80] },
      { address: destinationAddress, bytes: [0x01] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0x80] },
      { address: destinationAddress, bytes: [0x01] }
    ]
  },
  {
    name: "CMPSB subtracts the ES byte from the source byte and decrements indexes",
    bytes: [0xa6],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 1,
      ...compareInitialFlags
    },
    expectedState: {
      esi: 0xff,
      edi: 0x1ff,
      ...byteCompareFlags
    },
    memoryPatches: [
      { address: sourceAddress, bytes: [0x80] },
      { address: destinationAddress, bytes: [0x01] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0x80] },
      { address: destinationAddress, bytes: [0x01] }
    ]
  },
  {
    name: "CMPSW subtracts the ES word from the source word and increments indexes",
    bytes: [0x66, 0xa7],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...compareInitialFlags
    },
    expectedState: {
      esi: 0x102,
      edi: 0x202,
      ...wordCompareFlags
    },
    memoryPatches: [
      { address: sourceAddress, bytes: [0xff, 0x7f] },
      { address: destinationAddress, bytes: [0xff, 0xff] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0xff, 0x7f] },
      { address: destinationAddress, bytes: [0xff, 0xff] }
    ]
  },
  {
    name: "CMPSW subtracts the ES word from the source word and decrements indexes",
    bytes: [0x66, 0xa7],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 1,
      ...compareInitialFlags
    },
    expectedState: {
      esi: 0xfe,
      edi: 0x1fe,
      ...wordCompareFlags
    },
    memoryPatches: [
      { address: sourceAddress, bytes: [0xff, 0x7f] },
      { address: destinationAddress, bytes: [0xff, 0xff] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0xff, 0x7f] },
      { address: destinationAddress, bytes: [0xff, 0xff] }
    ]
  },
  {
    name: "CMPSD subtracts the ES dword from the source dword and increments indexes",
    bytes: [0xa7],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 0,
      ...compareInitialFlags
    },
    expectedState: {
      esi: 0x104,
      edi: 0x204,
      ...dwordCompareFlags
    },
    memoryPatches: [
      { address: sourceAddress, bytes: [0x00, 0x00, 0x00, 0x80] },
      { address: destinationAddress, bytes: [0x01, 0x00, 0x00, 0x00] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0x00, 0x00, 0x00, 0x80] },
      { address: destinationAddress, bytes: [0x01, 0x00, 0x00, 0x00] }
    ]
  },
  {
    name: "CMPSD subtracts the ES dword from the source dword and decrements indexes",
    bytes: [0xa7],
    initialState: {
      esi: sourceAddress,
      edi: destinationAddress,
      DF: 1,
      ...compareInitialFlags
    },
    expectedState: {
      esi: 0xfc,
      edi: 0x1fc,
      ...dwordCompareFlags
    },
    memoryPatches: [
      { address: sourceAddress, bytes: [0x00, 0x00, 0x00, 0x80] },
      { address: destinationAddress, bytes: [0x01, 0x00, 0x00, 0x00] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0x00, 0x00, 0x00, 0x80] },
      { address: destinationAddress, bytes: [0x01, 0x00, 0x00, 0x00] }
    ]
  },
  {
    name: "SCASB subtracts the ES byte from AL and increments EDI",
    bytes: [0xae],
    initialState: {
      eax: 0x1122_3380,
      esi: 0x345,
      edi: destinationAddress,
      DF: 0,
      ...compareInitialFlags
    },
    expectedState: { edi: 0x201, ...byteCompareFlags },
    memoryPatches: [{ address: destinationAddress, bytes: [0x01] }],
    expectedMemory: [{ address: destinationAddress, bytes: [0x01] }]
  },
  {
    name: "SCASB subtracts the ES byte from AL and decrements EDI",
    bytes: [0xae],
    initialState: {
      eax: 0x1122_3380,
      esi: 0x345,
      edi: destinationAddress,
      DF: 1,
      ...compareInitialFlags
    },
    expectedState: { edi: 0x1ff, ...byteCompareFlags },
    memoryPatches: [{ address: destinationAddress, bytes: [0x01] }],
    expectedMemory: [{ address: destinationAddress, bytes: [0x01] }]
  },
  {
    name: "SCASW subtracts the ES word from AX and increments EDI by two",
    bytes: [0x66, 0xaf],
    initialState: {
      eax: 0x1122_7fff,
      esi: 0x345,
      edi: destinationAddress,
      DF: 0,
      ...compareInitialFlags
    },
    expectedState: { edi: 0x202, ...wordCompareFlags },
    memoryPatches: [{ address: destinationAddress, bytes: [0xff, 0xff] }],
    expectedMemory: [{ address: destinationAddress, bytes: [0xff, 0xff] }]
  },
  {
    name: "SCASW subtracts the ES word from AX and decrements EDI by two",
    bytes: [0x66, 0xaf],
    initialState: {
      eax: 0x1122_7fff,
      esi: 0x345,
      edi: destinationAddress,
      DF: 1,
      ...compareInitialFlags
    },
    expectedState: { edi: 0x1fe, ...wordCompareFlags },
    memoryPatches: [{ address: destinationAddress, bytes: [0xff, 0xff] }],
    expectedMemory: [{ address: destinationAddress, bytes: [0xff, 0xff] }]
  },
  {
    name: "SCASD subtracts the ES dword from EAX and increments EDI by four",
    bytes: [0xaf],
    initialState: {
      eax: 0x8000_0000,
      esi: 0x345,
      edi: destinationAddress,
      DF: 0,
      ...compareInitialFlags
    },
    expectedState: { edi: 0x204, ...dwordCompareFlags },
    memoryPatches: [
      { address: destinationAddress, bytes: [0x01, 0x00, 0x00, 0x00] }
    ],
    expectedMemory: [
      { address: destinationAddress, bytes: [0x01, 0x00, 0x00, 0x00] }
    ]
  },
  {
    name: "SCASD subtracts the ES dword from EAX and decrements EDI by four",
    bytes: [0xaf],
    initialState: {
      eax: 0x8000_0000,
      esi: 0x345,
      edi: destinationAddress,
      DF: 1,
      ...compareInitialFlags
    },
    expectedState: { edi: 0x1fc, ...dwordCompareFlags },
    memoryPatches: [
      { address: destinationAddress, bytes: [0x01, 0x00, 0x00, 0x00] }
    ],
    expectedMemory: [
      { address: destinationAddress, bytes: [0x01, 0x00, 0x00, 0x00] }
    ]
  }
] as const satisfies readonly InstructionCase[];

for (const entry of oneShotCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("a source segment override changes MOVSB input but not its fixed ES destination", async () => {
  await assertInstructionCase({
    name: "FS MOVSB source selection",
    bytes: [0x64, 0xa4],
    initialState: {
      esi: 0x20,
      edi: 0x30,
      fsBase: 0x1000,
      gsBase: 0x3000,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { esi: 0x21, edi: 0x31 },
    memoryPatches: [
      { address: 0x20, bytes: [0x11] },
      { address: 0x1020, bytes: [0x7c] },
      { address: 0x30, bytes: [0x00] },
      { address: 0x3030, bytes: [0x55] }
    ],
    expectedMemory: [
      { address: 0x20, bytes: [0x11] },
      { address: 0x1020, bytes: [0x7c] },
      { address: 0x30, bytes: [0x7c] },
      { address: 0x3030, bytes: [0x55] }
    ]
  });
});

test("a segment override cannot redirect the fixed ES destination of STOSB", async () => {
  await assertInstructionCase({
    name: "GS STOSB destination selection",
    bytes: [0x65, 0xaa],
    initialState: {
      eax: 0x1122_335a,
      edi: 0x30,
      gsBase: 0x3000,
      DF: 0,
      ...preservedFlags
    },
    expectedState: { edi: 0x31 },
    memoryPatches: [
      { address: 0x30, bytes: [0x00] },
      { address: 0x3030, bytes: [0x55] }
    ],
    expectedMemory: [
      { address: 0x30, bytes: [0x5a] },
      { address: 0x3030, bytes: [0x55] }
    ]
  });
});

const faultCases = [
  {
    name: "LODSD reports its exact source read fault before changing EAX or ESI",
    bytes: [0xad],
    initialState: {
      eax: 0x1122_3344,
      esi: guestMemoryMinimumByteLength - 2,
      edi: 0x456,
      DF: 0,
      ...preservedFlags
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 0
      }
    },
    expectedEip: 0x1000,
    instructionCount: 0,
    memoryPatches: [
      { address: guestMemoryMinimumByteLength - 2, bytes: [0xaa, 0xbb] }
    ],
    expectedMemory: [
      { address: guestMemoryMinimumByteLength - 2, bytes: [0xaa, 0xbb] }
    ]
  },
  {
    name: "MOVSD reports its destination write fault after the source read without index progress",
    bytes: [0xa5],
    initialState: {
      esi: sourceAddress,
      edi: guestMemoryMinimumByteLength - 2,
      DF: 0,
      ...preservedFlags
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 2
      }
    },
    expectedEip: 0x1000,
    instructionCount: 0,
    memoryPatches: [
      { address: sourceAddress, bytes: [0xbe, 0xba, 0xfe, 0xca] },
      { address: guestMemoryMinimumByteLength - 2, bytes: [0xaa, 0xbb] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0xbe, 0xba, 0xfe, 0xca] },
      { address: guestMemoryMinimumByteLength - 2, bytes: [0xaa, 0xbb] }
    ]
  },
  {
    name: "CMPSD reports the source read when both implicit operands fault",
    bytes: [0xa7],
    initialState: {
      esi: guestMemoryMinimumByteLength,
      edi: guestMemoryMinimumByteLength - 1,
      DF: 0,
      ...compareInitialFlags
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 0
      }
    },
    expectedEip: 0x1000,
    instructionCount: 0
  },
  {
    name: "CMPSD reports the ES read fault after a valid source read without flags or index progress",
    bytes: [0xa7],
    initialState: {
      esi: sourceAddress,
      edi: guestMemoryMinimumByteLength - 2,
      DF: 0,
      ...compareInitialFlags
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 0
      }
    },
    expectedEip: 0x1000,
    instructionCount: 0,
    memoryPatches: [
      { address: sourceAddress, bytes: [0x00, 0x00, 0x00, 0x80] },
      { address: guestMemoryMinimumByteLength - 2, bytes: [0xaa, 0xbb] }
    ],
    expectedMemory: [
      { address: sourceAddress, bytes: [0x00, 0x00, 0x00, 0x80] },
      { address: guestMemoryMinimumByteLength - 2, bytes: [0xaa, 0xbb] }
    ]
  }
] as const satisfies readonly InstructionCase[];

for (const entry of faultCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}
