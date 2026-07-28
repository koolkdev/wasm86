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
  OF: 1
} as const;

const mixedFlags = {
  CF: 1,
  PF: 0,
  AF: 1,
  ZF: 0,
  SF: 1,
  OF: 1
} as const;

const registerExchangeCases = [
  {
    name: "XCHG swaps dword registers",
    bytes: [0x87, 0xd8],
    initialState: { eax: 0x1111_1111, ebx: 0x2222_2222, ...allFlagsSet },
    expectedState: { eax: 0x2222_2222, ebx: 0x1111_1111 }
  },
  {
    name: "XCHG swaps byte aliases without changing adjacent bytes",
    bytes: [0x86, 0xd8],
    initialState: { eax: 0x1234_5678, ebx: 0xaabb_ccdd, ...allFlagsSet },
    expectedState: { eax: 0x1234_56dd, ebx: 0xaabb_cc78 }
  },
  {
    name: "XCHG swaps word aliases without changing upper halves",
    bytes: [0x66, 0x87, 0xd8],
    initialState: { eax: 0x1234_5678, ebx: 0xaabb_ccdd, ...allFlagsSet },
    expectedState: { eax: 0x1234_ccdd, ebx: 0xaabb_5678 }
  },
  {
    name: "XCHG reads AL and AH before writing either alias",
    bytes: [0x86, 0xe0],
    initialState: { eax: 0x1234_5678, ...allFlagsSet },
    expectedState: { eax: 0x1234_7856 }
  },
  {
    name: "XCHG with the same register preserves its value",
    bytes: [0x87, 0xc0],
    initialState: { eax: 0x1234_5678, ...allFlagsSet }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of registerExchangeCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

const accumulatorExchangeCases = [
  {
    name: "91 exchanges EAX and ECX",
    bytes: [0x91],
    initialState: { eax: 0x1111_1111, ecx: 0x2222_2222, ...allFlagsSet },
    expectedState: { eax: 0x2222_2222, ecx: 0x1111_1111 }
  },
  {
    name: "66 93 exchanges AX and BX",
    bytes: [0x66, 0x93],
    initialState: { eax: 0xaaaa_1111, ebx: 0xbbbb_2222, ...allFlagsSet },
    expectedState: { eax: 0xaaaa_2222, ebx: 0xbbbb_1111 }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of accumulatorExchangeCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("XCHG memory addressing uses the original register value for both phases", async () => {
  const address = 0x2800;

  await assertInstructionCase({
    name: "XCHG [EBX], EBX",
    bytes: [0x87, 0x1b],
    initialState: { ebx: address, ...allFlagsSet },
    expectedState: { ebx: 0x1122_3344 },
    memoryPatches: [{ address: address - 1, bytes: [0xaa, ...dwordBytes(0x1122_3344), 0xbb] }],
    expectedMemory: [{ address: address - 1, bytes: [0xaa, ...dwordBytes(address), 0xbb] }]
  });
});

test("XCHG validates a complete memory write before changing the register or bytes", async () => {
  const address = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0x11, 0x22, 0x33];

  await assertInstructionCase({
    name: "XCHG trailing partial dword write fault",
    bytes: [0x87, 0x18],
    initialState: { eax: address, ebx: 0x1234_5678, ...allFlagsSet },
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
    memoryPatches: [{ address, bytes: initialBytes }],
    expectedMemory: [{ address, bytes: initialBytes }]
  });
});

const xaddCases = [
  {
    name: "XADD publishes the original destination to its source",
    bytes: [0x0f, 0xc1, 0xd8],
    initialState: { eax: 5, ebx: 7, ...allFlagsSet },
    expectedState: {
      eax: 12,
      ebx: 5,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "XADD with one register doubles the original value",
    bytes: [0x0f, 0xc1, 0xc0],
    initialState: { eax: 0x8000_0000, ...allFlagsSet },
    expectedState: {
      eax: 0,
      CF: 1,
      PF: 1,
      AF: 0,
      ZF: 1,
      SF: 0,
      OF: 1
    }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of xaddCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("XADD memory form writes the sum and returns the old destination", async () => {
  const address = 0x2900;

  await assertInstructionCase({
    name: "XADD [disp32], EBX",
    bytes: [0x0f, 0xc1, 0x1d, ...dwordBytes(address)],
    initialState: { ebx: 7, ...allFlagsSet },
    expectedState: {
      ebx: 5,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    },
    memoryPatches: [{ address, bytes: dwordBytes(5) }],
    expectedMemory: [{ address, bytes: dwordBytes(12) }]
  });
});

test("XADD memory faults before publishing its source, flags, or store", async () => {
  const address = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0x11, 0x22, 0x33];

  await assertInstructionCase({
    name: "XADD trailing partial dword write fault",
    bytes: [0x0f, 0xc1, 0x18],
    initialState: { eax: address, ebx: 7, ...allFlagsSet },
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
    memoryPatches: [{ address, bytes: initialBytes }],
    expectedMemory: [{ address, bytes: initialBytes }]
  });
});

const compareExchangeCases = [
  {
    name: "CMPXCHG register success stores the source",
    bytes: [0x0f, 0xb1, 0xd9],
    initialState: { eax: 5, ebx: 9, ecx: 5, ...allFlagsSet },
    expectedState: {
      ecx: 9,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 1,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "CMPXCHG register failure loads the accumulator and preserves the destination",
    bytes: [0x0f, 0xb1, 0xd9],
    initialState: { eax: 7, ebx: 9, ecx: 5, ...allFlagsSet },
    expectedState: {
      eax: 5,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "CMPXCHG accumulator alias retains the source written on success",
    bytes: [0x0f, 0xb1, 0xd8],
    initialState: { eax: 5, ebx: 9, ...allFlagsSet },
    expectedState: {
      eax: 9,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 1,
      SF: 0,
      OF: 0
    }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of compareExchangeCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("CMPXCHG memory success and failure publish only the selected branch", async () => {
  const successAddress = 0x2a00;
  const failureAddress = 0x2b00;

  await assertInstructionCase({
    name: "CMPXCHG memory success",
    bytes: [0x0f, 0xb1, 0x1d, ...dwordBytes(successAddress)],
    initialState: { eax: 5, ebx: 0x1122_3344, ...allFlagsSet },
    expectedState: {
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 1,
      SF: 0,
      OF: 0
    },
    memoryPatches: [{ address: successAddress, bytes: dwordBytes(5) }],
    expectedMemory: [{ address: successAddress, bytes: dwordBytes(0x1122_3344) }]
  });

  await assertInstructionCase({
    name: "CMPXCHG memory failure",
    bytes: [0x0f, 0xb1, 0x1d, ...dwordBytes(failureAddress)],
    initialState: { eax: 7, ebx: 0x5566_7788, ...allFlagsSet },
    expectedState: {
      eax: 5,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    },
    memoryPatches: [{ address: failureAddress, bytes: dwordBytes(5) }],
    expectedMemory: [{ address: failureAddress, bytes: dwordBytes(5) }]
  });
});

test("CMPXCHG memory validates its write view before changing state", async () => {
  const address = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0x11, 0x22, 0x33];

  await assertInstructionCase({
    name: "CMPXCHG trailing partial dword write fault",
    bytes: [0x0f, 0xb1, 0x18],
    initialState: { eax: address, ebx: 9, ...allFlagsSet },
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
    memoryPatches: [{ address, bytes: initialBytes }],
    expectedMemory: [{ address, bytes: initialBytes }]
  });
});

test("CMPXCHG8B stores EBX:ECX on success and changes only ZF", async () => {
  const address = 0x2c00;

  await assertInstructionCase({
    name: "CMPXCHG8B success",
    bytes: [0x0f, 0xc7, 0x0d, ...dwordBytes(address)],
    initialState: {
      eax: 0x1111_1111,
      edx: 0x2222_2222,
      ebx: 0x3333_3333,
      ecx: 0x4444_4444,
      ...mixedFlags
    },
    expectedState: { ZF: 1 },
    memoryPatches: [
      {
        address,
        bytes: [...dwordBytes(0x1111_1111), ...dwordBytes(0x2222_2222)]
      }
    ],
    expectedMemory: [
      {
        address,
        bytes: [...dwordBytes(0x3333_3333), ...dwordBytes(0x4444_4444)]
      }
    ]
  });
});

test("CMPXCHG8B loads EDX:EAX and leaves memory unchanged on failure", async () => {
  const address = 0x2d00;
  // prettier-ignore
  const initialMemory = [
    ...dwordBytes(0x1111_1111),
    ...dwordBytes(0x2222_2222)
  ];

  await assertInstructionCase({
    name: "CMPXCHG8B failure",
    bytes: [0x0f, 0xc7, 0x0d, ...dwordBytes(address)],
    initialState: {
      eax: 0x9999_9999,
      edx: 0x8888_8888,
      ebx: 0x3333_3333,
      ecx: 0x4444_4444,
      ...allFlagsSet
    },
    expectedState: {
      eax: 0x1111_1111,
      edx: 0x2222_2222,
      ZF: 0
    },
    memoryPatches: [{ address, bytes: initialMemory }],
    expectedMemory: [{ address, bytes: initialMemory }]
  });
});

test("CMPXCHG8B validates the full qword write before publishing any half", async () => {
  const address = guestMemoryMinimumByteLength - 4;
  const initialBytes = dwordBytes(0x89ab_cdef);

  await assertInstructionCase({
    name: "CMPXCHG8B trailing partial qword write fault",
    bytes: [0x0f, 0xc7, 0x08],
    initialState: {
      eax: address,
      edx: 0x2222_2222,
      ebx: 0x3333_3333,
      ecx: 0x4444_4444,
      ...mixedFlags
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
    memoryPatches: [{ address, bytes: initialBytes }],
    expectedMemory: [{ address, bytes: initialBytes }]
  });
});

function dwordBytes(value: number): readonly number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}
