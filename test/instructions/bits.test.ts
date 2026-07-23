import { test } from "node:test";

import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import {
  assertInstructionCase,
  type InstructionCase
} from "#test/instructions/harness/instruction-case.js";
import { startAddress } from "#test/support/addresses.js";

const preservedFlags = {
  CF: 1,
  PF: 0,
  AF: 1,
  ZF: 0,
  SF: 1,
  OF: 1
} as const;

const registerBitCases = [
  {
    name: "BT masks a dword register offset",
    bytes: [0x0f, 0xa3, 0xc8],
    initialState: { eax: 0x20, ecx: 37, ...preservedFlags },
    expectedState: { CF: 1 }
  },
  {
    name: "BTS masks a dword register offset before setting the bit",
    bytes: [0x0f, 0xab, 0xc8],
    initialState: { eax: 0, ecx: 33, ...preservedFlags },
    expectedState: { eax: 2, CF: 0 }
  },
  {
    name: "BTR masks a dword register offset before clearing the bit",
    bytes: [0x0f, 0xb3, 0xc8],
    initialState: { eax: 2, ecx: 33, ...preservedFlags },
    expectedState: { eax: 0, CF: 1 }
  },
  {
    name: "BTC masks a dword register offset before complementing the bit",
    bytes: [0x0f, 0xbb, 0xc8],
    initialState: { eax: 0, ecx: 33, ...preservedFlags },
    expectedState: { eax: 2, CF: 0 }
  },
  {
    name: "BT masks a word register offset to four bits",
    bytes: [0x66, 0x0f, 0xa3, 0xd0],
    initialState: { eax: 0xaaaa_8000, edx: 31, ...preservedFlags },
    expectedState: { CF: 1 }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of registerBitCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("memory bit strings adjust positive register offsets by whole dwords", async () => {
  const base = 0x2400;
  const initialBytes = [
    0x11, 0x22, 0x33, 0x44,
    0x00, 0x00, 0x00, 0x00,
    0x55, 0x66, 0x77, 0x88
  ];

  await assertInstructionCase({
    name: "BTS [EAX], ECX with bit offset 37",
    bytes: [0x0f, 0xab, 0x08],
    initialState: { eax: base, ecx: 37, ...preservedFlags },
    expectedState: { CF: 0 },
    memoryPatches: [{ address: base, bytes: initialBytes }],
    expectedMemory: [{
      address: base,
      bytes: [
        0x11, 0x22, 0x33, 0x44,
        0x20, 0x00, 0x00, 0x00,
        0x55, 0x66, 0x77, 0x88
      ]
    }]
  });
});

test("memory bit strings adjust negative register offsets below the effective address", async () => {
  const base = 0x2504;
  const sentinelBytes = [
    0xaa, 0xbb, 0xcc, 0x80,
    0x11, 0x22, 0x33, 0x44
  ];

  await assertInstructionCase({
    name: "BTR [EAX], ECX with bit offset -1",
    bytes: [0x0f, 0xb3, 0x08],
    initialState: { eax: base, ecx: 0xffff_ffff, ...preservedFlags },
    expectedState: { CF: 1 },
    memoryPatches: [{ address: base - 4, bytes: sentinelBytes }],
    expectedMemory: [{
      address: base - 4,
      bytes: [0xaa, 0xbb, 0xcc, 0x00, 0x11, 0x22, 0x33, 0x44]
    }]
  });

  await assertInstructionCase({
    name: "BTC [EAX], ECX with bit offset -32",
    bytes: [0x0f, 0xbb, 0x08],
    initialState: { eax: base, ecx: 0xffff_ffe0, ...preservedFlags },
    expectedState: { CF: 0 },
    memoryPatches: [{ address: base - 4, bytes: [0, 0, 0, 0, 0x55] }],
    expectedMemory: [{ address: base - 4, bytes: [1, 0, 0, 0, 0x55] }]
  });
});

test("memory bit immediates stay at the decoded effective address and mask within it", async () => {
  const address = 0x2600;

  await assertInstructionCase({
    name: "BTS dword [disp32], immediate 36",
    bytes: [0x0f, 0xba, 0x2d, ...dwordBytes(address), 36],
    initialState: preservedFlags,
    expectedState: { CF: 0 },
    memoryPatches: [{ address: address - 1, bytes: [0xaa, 0, 0, 0, 0, 0xbb] }],
    expectedMemory: [{ address: address - 1, bytes: [0xaa, 0x10, 0, 0, 0, 0xbb] }]
  });
});

test("adjusted memory bit reads fault at their actual positive and negative ranges", async () => {
  await assertInstructionCase({
    name: "positive adjusted BT read fault",
    bytes: [0x0f, 0xa3, 0x08],
    initialState: {
      eax: guestMemoryMinimumByteLength - 4,
      ecx: 32,
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
    expectedEip: startAddress,
    instructionCount: 0
  });

  await assertInstructionCase({
    name: "negative adjusted BT read fault",
    bytes: [0x0f, 0xa3, 0x08],
    initialState: { eax: 0, ecx: 0xffff_ffe0, ...preservedFlags },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: 0xffff_fffc,
        errorCode: 0
      }
    },
    expectedEip: startAddress,
    instructionCount: 0
  });
});

test("mutating memory bit operations validate the entire adjusted dword before writing", async () => {
  const address = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0xa1, 0xb2, 0xc3];

  await assertInstructionCase({
    name: "positive adjusted BTS write fault",
    bytes: [0x0f, 0xab, 0x08],
    initialState: {
      eax: address - 4,
      ecx: 32,
      ...preservedFlags
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: { kind: "PF", linearAddress: address, errorCode: 2 }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{ address, bytes: initialBytes }],
    expectedMemory: [{ address, bytes: initialBytes }]
  });
});

const bitScanCases = [
  {
    name: "BSF finds the least-significant set dword bit",
    bytes: [0x0f, 0xbc, 0xc3],
    initialState: { eax: 0xaaaa_5555, ebx: 0x100, ...preservedFlags },
    expectedState: {
      eax: 8,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "BSF preserves its dword destination for a zero source",
    bytes: [0x0f, 0xbc, 0xc3],
    initialState: { eax: 0xaaaa_5555, ebx: 0, ...preservedFlags },
    expectedState: {
      eax: 0xaaaa_5555,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 1,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "BSR finds the most-significant set word bit and preserves upper EAX",
    bytes: [0x66, 0x0f, 0xbd, 0xc3],
    initialState: { eax: 0xaaaa_0000, ebx: 0x20, ...preservedFlags },
    expectedState: {
      eax: 0xaaaa_0005,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "BSR preserves its word destination for a zero source",
    bytes: [0x66, 0x0f, 0xbd, 0xc3],
    initialState: { eax: 0xaaaa_1234, ebx: 0, ...preservedFlags },
    expectedState: {
      eax: 0xaaaa_1234,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 1,
      SF: 0,
      OF: 0
    }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of bitScanCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("bit scans read memory sources and publish only after a complete read", async () => {
  const address = 0x2700;

  await assertInstructionCase({
    name: "BSF dword memory source",
    bytes: [0x0f, 0xbc, 0x05, ...dwordBytes(address)],
    initialState: { eax: 0xaaaa_5555, ...preservedFlags },
    expectedState: {
      eax: 5,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    },
    memoryPatches: [{ address, bytes: dwordBytes(0x120) }],
    expectedMemory: [{ address, bytes: dwordBytes(0x120) }]
  });

  const faultAddress = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0x20, 0x01, 0x00];

  await assertInstructionCase({
    name: "BSF dword memory source fault",
    bytes: [0x0f, 0xbc, 0x05, ...dwordBytes(faultAddress)],
    initialState: { eax: 0xaaaa_5555, ...preservedFlags },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: faultAddress,
        errorCode: 0
      }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{ address: faultAddress, bytes: initialBytes }],
    expectedMemory: [{ address: faultAddress, bytes: initialBytes }]
  });
});

test("BSWAP reverses all four bytes and preserves flags", async () => {
  await assertInstructionCase({
    name: "BSWAP EBX",
    bytes: [0x0f, 0xcb],
    initialState: { ebx: 0x1234_5678, ...preservedFlags },
    expectedState: { ebx: 0x7856_3412 }
  });
});

function dwordBytes(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}
