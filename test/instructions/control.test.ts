import { test } from "node:test";

import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import {
  assertInstructionCase,
  type InstructionCase
} from "#test/instructions/harness/instruction-case.js";
import { startAddress } from "#test/support/addresses.js";

type ConditionFlags = Readonly<{
  CF?: 0 | 1;
  PF?: 0 | 1;
  ZF?: 0 | 1;
  SF?: 0 | 1;
  OF?: 0 | 1;
}>;

type ConditionCase = Readonly<{
  name: string;
  jccOpcode: number;
  setccOpcode: number;
  takenFlags: ConditionFlags;
  notTakenFlags: ConditionFlags;
}>;

const conditionCases = [
  {
    name: "O",
    jccOpcode: 0x70,
    setccOpcode: 0x90,
    takenFlags: { OF: 1 },
    notTakenFlags: {}
  },
  {
    name: "NO",
    jccOpcode: 0x71,
    setccOpcode: 0x91,
    takenFlags: {},
    notTakenFlags: { OF: 1 }
  },
  {
    name: "B",
    jccOpcode: 0x72,
    setccOpcode: 0x92,
    takenFlags: { CF: 1 },
    notTakenFlags: {}
  },
  {
    name: "AE",
    jccOpcode: 0x73,
    setccOpcode: 0x93,
    takenFlags: {},
    notTakenFlags: { CF: 1 }
  },
  {
    name: "E",
    jccOpcode: 0x74,
    setccOpcode: 0x94,
    takenFlags: { ZF: 1 },
    notTakenFlags: {}
  },
  {
    name: "NE",
    jccOpcode: 0x75,
    setccOpcode: 0x95,
    takenFlags: {},
    notTakenFlags: { ZF: 1 }
  },
  {
    name: "BE",
    jccOpcode: 0x76,
    setccOpcode: 0x96,
    takenFlags: { CF: 1 },
    notTakenFlags: {}
  },
  {
    name: "A",
    jccOpcode: 0x77,
    setccOpcode: 0x97,
    takenFlags: {},
    notTakenFlags: { ZF: 1 }
  },
  {
    name: "S",
    jccOpcode: 0x78,
    setccOpcode: 0x98,
    takenFlags: { SF: 1 },
    notTakenFlags: {}
  },
  {
    name: "NS",
    jccOpcode: 0x79,
    setccOpcode: 0x99,
    takenFlags: {},
    notTakenFlags: { SF: 1 }
  },
  {
    name: "P",
    jccOpcode: 0x7a,
    setccOpcode: 0x9a,
    takenFlags: { PF: 1 },
    notTakenFlags: {}
  },
  {
    name: "NP",
    jccOpcode: 0x7b,
    setccOpcode: 0x9b,
    takenFlags: {},
    notTakenFlags: { PF: 1 }
  },
  {
    name: "L",
    jccOpcode: 0x7c,
    setccOpcode: 0x9c,
    takenFlags: { SF: 1 },
    notTakenFlags: {}
  },
  {
    name: "GE",
    jccOpcode: 0x7d,
    setccOpcode: 0x9d,
    takenFlags: {},
    notTakenFlags: { SF: 1 }
  },
  {
    name: "LE",
    jccOpcode: 0x7e,
    setccOpcode: 0x9e,
    takenFlags: { ZF: 1 },
    notTakenFlags: {}
  },
  {
    name: "G",
    jccOpcode: 0x7f,
    setccOpcode: 0x9f,
    takenFlags: {},
    notTakenFlags: { ZF: 1 }
  }
] as const satisfies readonly ConditionCase[];

const preservedFlags = { CF: 1, PF: 1, AF: 1, SF: 1, OF: 1, DF: 1 } as const;

test("every short Jcc condition dispatches when true and falls through when false", async () => {
  for (const entry of conditionCases) {
    const bytes = [entry.jccOpcode, 0x02];

    await assertInstructionCase({
      name: `J${entry.name} taken`,
      bytes,
      initialState: { eax: 0x1234_5678, DF: 1, ...entry.takenFlags },
      expectedCompletion: { kind: "dispatched", targetEip: startAddress + 4 },
      expectedEip: startAddress + 4
    });
    await assertInstructionCase({
      name: `J${entry.name} not taken`,
      bytes,
      initialState: { eax: 0x1234_5678, DF: 1, ...entry.notTakenFlags },
      expectedEip: startAddress + 2
    });
  }
});

test("Jcc signed displacement widths resolve targets relative to the next instruction", async () => {
  const cases: readonly InstructionCase[] = [
    {
      name: "JNE rel16 negative displacement",
      bytes: [0x66, 0x0f, 0x85, 0xfc, 0xff],
      initialState: { ZF: 0, ...preservedFlags },
      expectedCompletion: { kind: "dispatched", targetEip: startAddress + 1 },
      expectedEip: startAddress + 1
    },
    {
      name: "JL rel32 negative displacement",
      bytes: [0x0f, 0x8c, 0xfa, 0xff, 0xff, 0xff],
      initialState: { ...preservedFlags, SF: 1, OF: 0 },
      expectedCompletion: { kind: "dispatched", targetEip: startAddress },
      expectedEip: startAddress
    }
  ];

  for (const entry of cases) {
    await assertInstructionCase(entry);
  }
});

test("a taken same-target branch remains distinguishable from fallthrough", async () => {
  const bytes = [0x74, 0x00];

  await assertInstructionCase({
    name: "JE taken to its next EIP",
    bytes,
    initialState: { eax: 0xaaaa_aaaa, ZF: 1, DF: 1 },
    expectedCompletion: { kind: "dispatched", targetEip: startAddress + 2 }
  });
  await assertInstructionCase({
    name: "JE false at the same numerical EIP",
    bytes,
    initialState: { eax: 0xaaaa_aaaa, ZF: 0, DF: 1 }
  });
});

test("near JMP forms dispatch signed relative and register targets", async () => {
  const cases: readonly InstructionCase[] = [
    {
      name: "JMP rel8 negative displacement",
      bytes: [0xeb, 0xfc],
      initialState: preservedFlags,
      expectedCompletion: { kind: "dispatched", targetEip: startAddress - 2 },
      expectedEip: startAddress - 2
    },
    {
      name: "JMP rel16 negative displacement",
      bytes: [0x66, 0xe9, 0xfc, 0xff],
      initialState: preservedFlags,
      expectedCompletion: { kind: "dispatched", targetEip: startAddress },
      expectedEip: startAddress
    },
    {
      name: "JMP rel32 negative displacement",
      bytes: [0xe9, 0xfc, 0xff, 0xff, 0xff],
      initialState: preservedFlags,
      expectedCompletion: { kind: "dispatched", targetEip: startAddress + 1 },
      expectedEip: startAddress + 1
    },
    {
      name: "JMP r/m32 register target",
      bytes: [0xff, 0xe0],
      initialState: { eax: 0x2000, ...preservedFlags },
      expectedCompletion: { kind: "dispatched", targetEip: 0x2000 },
      expectedEip: 0x2000
    },
    {
      name: "JMP r/m16 masks the register target without changing EAX",
      bytes: [0x66, 0xff, 0xe0],
      initialState: { eax: 0x1234_2000, ...preservedFlags },
      expectedCompletion: { kind: "dispatched", targetEip: 0x2000 },
      expectedEip: 0x2000
    }
  ];

  for (const entry of cases) {
    await assertInstructionCase(entry);
  }
});

test("every SETcc condition writes its selected register or memory byte without changing flags", async () => {
  for (const [index, entry] of conditionCases.entries()) {
    const address = 0x300 + index * 4;

    await assertInstructionCase({
      name: `SET${entry.name} register true`,
      bytes: [0x0f, entry.setccOpcode, 0xc0],
      initialState: {
        eax: 0x1234_56aa,
        AF: 1,
        DF: 1,
        ...entry.takenFlags
      },
      expectedState: { eax: 0x1234_5601 }
    });
    await assertInstructionCase({
      name: `SET${entry.name} memory false`,
      bytes: [0x0f, entry.setccOpcode, 0x03],
      initialState: {
        ebx: address,
        AF: 1,
        DF: 1,
        ...entry.notTakenFlags
      },
      memoryPatches: [{ address: address - 1, bytes: [0xaa, 0xcc, 0xbb] }],
      expectedMemory: [{ address: address - 1, bytes: [0xaa, 0x00, 0xbb] }]
    });
  }
});

test("SETcc supports a high-byte register and reports an exact memory write fault", async () => {
  await assertInstructionCase({
    name: "SETNE AH writes only the high byte",
    bytes: [0x0f, 0x95, 0xc4],
    initialState: { eax: 0x1234_5678, ZF: 1, ...preservedFlags },
    expectedState: { eax: 0x1234_0078 }
  });

  await assertInstructionCase({
    name: "SETE byte store faults before changing state",
    bytes: [0x0f, 0x94, 0x03],
    initialState: {
      ebx: guestMemoryMinimumByteLength,
      ZF: 1,
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
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{
      address: guestMemoryMinimumByteLength - 1,
      bytes: [0x5a]
    }],
    expectedMemory: [{
      address: guestMemoryMinimumByteLength - 1,
      bytes: [0x5a]
    }]
  });
});

test("LOOP-family controls update ECX and preserve flags on taken and fallthrough paths", async () => {
  const cases: readonly InstructionCase[] = [
    {
      name: "LOOP taken",
      bytes: [0xe2, 0x20],
      initialState: { ecx: 2, ZF: 1, ...preservedFlags },
      expectedState: { ecx: 1 },
      expectedCompletion: {
        kind: "dispatched",
        targetEip: startAddress + 0x22
      },
      expectedEip: startAddress + 0x22
    },
    {
      name: "LOOP falls through at zero",
      bytes: [0xe2, 0x20],
      initialState: { ecx: 1, ZF: 1, ...preservedFlags },
      expectedState: { ecx: 0 }
    },
    {
      name: "LOOPE taken with nonzero counter and ZF set",
      bytes: [0xe1, 0x20],
      initialState: { ecx: 2, ZF: 1, ...preservedFlags },
      expectedState: { ecx: 1 },
      expectedCompletion: {
        kind: "dispatched",
        targetEip: startAddress + 0x22
      },
      expectedEip: startAddress + 0x22
    },
    {
      name: "LOOPE decrements then falls through with ZF clear",
      bytes: [0xe1, 0x20],
      initialState: { ecx: 2, ...preservedFlags, ZF: 0 },
      expectedState: { ecx: 1 }
    },
    {
      name: "LOOPNE taken with nonzero counter and ZF clear",
      bytes: [0xe0, 0x20],
      initialState: { ecx: 2, ...preservedFlags, ZF: 0 },
      expectedState: { ecx: 1 },
      expectedCompletion: {
        kind: "dispatched",
        targetEip: startAddress + 0x22
      },
      expectedEip: startAddress + 0x22
    },
    {
      name: "LOOPNE decrements then falls through with ZF set",
      bytes: [0xe0, 0x20],
      initialState: { ecx: 2, ZF: 1, ...preservedFlags },
      expectedState: { ecx: 1 }
    }
  ];

  for (const entry of cases) {
    await assertInstructionCase(entry);
  }
});

test("JECXZ tests ECX without changing it or the flags", async () => {
  await assertInstructionCase({
    name: "zero counter branches",
    bytes: [0xe3, 0x20],
    initialState: { ecx: 0, ZF: 1, ...preservedFlags },
    expectedCompletion: {
      kind: "dispatched",
      targetEip: startAddress + 0x22
    },
    expectedEip: startAddress + 0x22
  });
  await assertInstructionCase({
    name: "nonzero counter falls through",
    bytes: [0xe3, 0x20],
    initialState: { ecx: 1, ZF: 1, ...preservedFlags }
  });
});

test("CALL pushes the next instruction address before dispatching", async () => {
  const cases: readonly InstructionCase[] = [
    {
      name: "CALL rel32 pushes a dword return address",
      bytes: [0xe8, 0x0b, 0x00, 0x00, 0x00],
      initialState: { esp: 0x40, ...preservedFlags },
      expectedState: { esp: 0x3c },
      expectedCompletion: {
        kind: "dispatched",
        targetEip: startAddress + 0x10
      },
      expectedEip: startAddress + 0x10,
      memoryPatches: [{ address: 0x3b, bytes: [0xaa, 0, 0, 0, 0, 0xbb] }],
      expectedMemory: [{ address: 0x3b, bytes: [0xaa, 0x05, 0x10, 0x00, 0x00, 0xbb] }]
    },
    {
      name: "CALL rel16 pushes a word return address",
      bytes: [0x66, 0xe8, 0x0b, 0x00],
      initialState: { esp: 0x40, ...preservedFlags },
      expectedState: { esp: 0x3e },
      expectedCompletion: {
        kind: "dispatched",
        targetEip: startAddress + 0x0f
      },
      expectedEip: startAddress + 0x0f,
      memoryPatches: [{ address: 0x3d, bytes: [0xaa, 0, 0, 0xbb] }],
      expectedMemory: [{ address: 0x3d, bytes: [0xaa, 0x04, 0x10, 0xbb] }]
    },
    {
      name: "CALL [ESP] resolves its target from the old stack pointer",
      bytes: [0xff, 0x14, 0x24],
      initialState: { esp: 0x40, ...preservedFlags },
      expectedState: { esp: 0x3c },
      expectedCompletion: { kind: "dispatched", targetEip: 0x1234 },
      expectedEip: 0x1234,
      memoryPatches: [{
        address: 0x3b,
        bytes: [0xaa, 0, 0, 0, 0, 0x34, 0x12, 0, 0, 0xbb]
      }],
      expectedMemory: [{
        address: 0x3b,
        bytes: [0xaa, 0x03, 0x10, 0, 0, 0x34, 0x12, 0, 0, 0xbb]
      }]
    }
  ];

  for (const entry of cases) {
    await assertInstructionCase(entry);
  }
});

test("CALL validates its target read before any stack write and commits neither side of a fault", async () => {
  const sourceFault = guestMemoryMinimumByteLength - 2;

  await assertInstructionCase({
    name: "faulting memory target leaves a valid would-be stack slot unchanged",
    bytes: [0xff, 0x13],
    initialState: { ebx: sourceFault, esp: 0x80, ...preservedFlags },
    expectedCompletion: {
      kind: "cpuException",
      exception: { kind: "PF", linearAddress: sourceFault, errorCode: 0 }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [
      { address: sourceFault, bytes: [0x34, 0x12] },
      { address: 0x7c, bytes: [0xaa, 0xbb, 0xcc, 0xdd] }
    ],
    expectedMemory: [
      { address: sourceFault, bytes: [0x34, 0x12] },
      { address: 0x7c, bytes: [0xaa, 0xbb, 0xcc, 0xdd] }
    ]
  });

  await assertInstructionCase({
    name: "validated register target is not dispatched when the stack write faults",
    bytes: [0xff, 0xd0],
    initialState: {
      eax: 0x2000,
      esp: guestMemoryMinimumByteLength + 2,
      ...preservedFlags
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength - 2,
        errorCode: 2
      }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{
      address: guestMemoryMinimumByteLength - 2,
      bytes: [0xaa, 0xbb]
    }],
    expectedMemory: [{
      address: guestMemoryMinimumByteLength - 2,
      bytes: [0xaa, 0xbb]
    }]
  });
});

test("RET pops near targets and applies unsigned immediate cleanup before dispatch", async () => {
  const cases: readonly InstructionCase[] = [
    {
      name: "RET pops a dword target",
      bytes: [0xc3],
      initialState: { esp: 0x40, ...preservedFlags },
      expectedState: { esp: 0x44 },
      expectedCompletion: { kind: "dispatched", targetEip: 0x3000 },
      expectedEip: 0x3000,
      memoryPatches: [{ address: 0x40, bytes: [0x00, 0x30, 0x00, 0x00] }],
      expectedMemory: [{ address: 0x40, bytes: [0x00, 0x30, 0x00, 0x00] }]
    },
    {
      name: "RET o16 pops a word target",
      bytes: [0x66, 0xc3],
      initialState: { esp: 0x40, ...preservedFlags },
      expectedState: { esp: 0x42 },
      expectedCompletion: { kind: "dispatched", targetEip: 0x3456 },
      expectedEip: 0x3456,
      memoryPatches: [{ address: 0x40, bytes: [0x56, 0x34] }],
      expectedMemory: [{ address: 0x40, bytes: [0x56, 0x34] }]
    },
    {
      name: "RET imm16 treats cleanup as unsigned",
      bytes: [0xc2, 0x34, 0x80],
      initialState: { esp: 0x40, ...preservedFlags },
      expectedState: { esp: 0x8078 },
      expectedCompletion: {
        kind: "dispatched",
        targetEip: 0x1234_5678
      },
      expectedEip: 0x1234_5678,
      memoryPatches: [{ address: 0x40, bytes: [0x78, 0x56, 0x34, 0x12] }],
      expectedMemory: [{ address: 0x40, bytes: [0x78, 0x56, 0x34, 0x12] }]
    },
    {
      name: "RET imm16 o16 adds cleanup after the word pop",
      bytes: [0x66, 0xc2, 0x08, 0x00],
      initialState: { esp: 0x40, ...preservedFlags },
      expectedState: { esp: 0x4a },
      expectedCompletion: { kind: "dispatched", targetEip: 0x5678 },
      expectedEip: 0x5678,
      memoryPatches: [{ address: 0x40, bytes: [0x78, 0x56] }],
      expectedMemory: [{ address: 0x40, bytes: [0x78, 0x56] }]
    }
  ];

  for (const entry of cases) {
    await assertInstructionCase(entry);
  }
});

test("RET read faults leave EIP, ESP, cleanup, and memory uncommitted", async () => {
  const faultAddress = guestMemoryMinimumByteLength - 2;

  await assertInstructionCase({
    name: "partial dword target read",
    bytes: [0xc2, 0x34, 0x80],
    initialState: { esp: faultAddress, ...preservedFlags },
    expectedCompletion: {
      kind: "cpuException",
      exception: { kind: "PF", linearAddress: faultAddress, errorCode: 0 }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{ address: faultAddress, bytes: [0x78, 0x56] }],
    expectedMemory: [{ address: faultAddress, bytes: [0x78, 0x56] }]
  });
});
