import { test } from "node:test";

import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import {
  assertInstructionCase,
  type InstructionCase
} from "#test/instructions/harness/instruction-case.js";
import { startAddress } from "#test/support/addresses.js";

const allFlagsSet = {
  CF: 1,
  PF: 1,
  AF: 1,
  ZF: 1,
  SF: 1,
  OF: 1,
  DF: 1
} as const;

test("LEA forms compute offsets without reading guest memory or adding segment bases", async () => {
  const cases: readonly InstructionCase[] = [
    {
      name: "dword base + index*4 + disp8 wraps at 32 bits and ignores FS",
      bytes: [0x64, 0x8d, 0x44, 0x8b, 0x10],
      initialState: {
        eax: 0xdead_beef,
        ebx: 0xffff_fff0,
        ecx: 3,
        fsBase: guestMemoryMinimumByteLength,
        ...allFlagsSet
      },
      expectedState: { eax: 0x0000_000c }
    },
    {
      name: "word destination preserves the upper half of EAX",
      bytes: [0x66, 0x8d, 0x44, 0xb3, 0x08],
      initialState: {
        eax: 0x1234_0000,
        ebx: 0x100,
        esi: 3,
        ...allFlagsSet
      },
      expectedState: { eax: 0x1234_0114 }
    },
    {
      name: "base-less SIB uses index*4 plus disp32",
      bytes: [0x8d, 0x04, 0x8d, 0x20, 0x00, 0x00, 0x00],
      initialState: { eax: 0xffff_ffff, ecx: 2, ...allFlagsSet },
      expectedState: { eax: 0x28 }
    }
  ];

  for (const entry of cases) {
    await assertInstructionCase(entry);
  }
});

test("XLAT adds unsigned AL to EBX and honors an explicit segment override", async () => {
  const cases: readonly InstructionCase[] = [
    {
      name: "unprefixed default remains flat",
      bytes: [0xd7],
      initialState: {
        eax: 0x1234_5605,
        ebx: 0x20,
        dsBase: 0x1000,
        ...allFlagsSet
      },
      expectedState: { eax: 0x1234_56ab },
      memoryPatches: [
        { address: 0x25, bytes: [0xab] },
        { address: 0x1025, bytes: [0x11] }
      ],
      expectedMemory: [
        { address: 0x25, bytes: [0xab] },
        { address: 0x1025, bytes: [0x11] }
      ]
    },
    {
      name: "FS override leaves DS data unused",
      bytes: [0x64, 0xd7],
      initialState: {
        eax: 0xaabb_cc03,
        ebx: 0x40,
        dsBase: 0x1000,
        fsBase: 0x2000,
        ...allFlagsSet
      },
      expectedState: { eax: 0xaabb_cc7e },
      memoryPatches: [
        { address: 0x1043, bytes: [0x11] },
        { address: 0x2043, bytes: [0x7e] }
      ],
      expectedMemory: [
        { address: 0x1043, bytes: [0x11] },
        { address: 0x2043, bytes: [0x7e] }
      ]
    }
  ];

  for (const entry of cases) {
    await assertInstructionCase(entry);
  }
});

test("XLAT reports the adjusted one-byte read fault before changing AL", async () => {
  const faultAddress = guestMemoryMinimumByteLength;

  await assertInstructionCase({
    name: "EBX + unsigned AL reaches the first byte beyond guest memory",
    bytes: [0xd7],
    initialState: {
      eax: 0x1234_5601,
      ebx: faultAddress - 1,
      ...allFlagsSet
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: { kind: "PF", linearAddress: faultAddress, errorCode: 0 }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{ address: faultAddress - 1, bytes: [0x5a] }],
    expectedMemory: [{ address: faultAddress - 1, bytes: [0x5a] }]
  });
});
