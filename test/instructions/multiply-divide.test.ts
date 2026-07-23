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

const nonStatusFlags = {
  TF: 1,
  DF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

const multiplyNoOverflowFlags = {
  CF: 0,
  PF: 1,
  AF: 0,
  ZF: 0,
  SF: 0,
  OF: 0
} as const;

const multiplyOverflowFlags = {
  CF: 1,
  PF: 1,
  AF: 0,
  ZF: 0,
  SF: 0,
  OF: 1
} as const;

const explicitMultiplyCases = [
  {
    name: "IMUL r32 by r/m32 keeps an in-range signed product",
    bytes: [0x0f, 0xaf, 0xc3],
    initialState: { eax: 3, ebx: 0xffff_fffe, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xffff_fffa, ...multiplyNoOverflowFlags }
  },
  {
    name: "IMUL r32 by r/m32 reports signed overflow",
    bytes: [0x0f, 0xaf, 0xc3],
    initialState: { eax: 0x4000_0000, ebx: 2, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0x8000_0000, ...multiplyOverflowFlags }
  },
  {
    name: "IMUL r16 by r/m16 preserves the high destination word",
    bytes: [0x66, 0x0f, 0xaf, 0xc3],
    initialState: { eax: 0x1234_0003, ebx: 0x0000_fffe, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0x1234_fffa, ...multiplyNoOverflowFlags }
  },
  {
    name: "IMUL sign-extends its imm32 source",
    bytes: [0x69, 0xc3, 0xff, 0xff, 0xff, 0xff],
    initialState: { ebx: 5, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xffff_fffb, ...multiplyNoOverflowFlags }
  },
  {
    name: "IMUL sign-extends its imm8 source",
    bytes: [0x6b, 0xc3, 0xfe],
    initialState: { ebx: 5, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xffff_fff6, ...multiplyNoOverflowFlags }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of explicitMultiplyCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

const implicitMultiplyCases = [
  {
    name: "MUL r/m8 writes its unsigned product to AX",
    bytes: [0xf6, 0xe3],
    initialState: { eax: 0xaaaa_0012, ebx: 3, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xaaaa_0036, ...multiplyNoOverflowFlags }
  },
  {
    name: "MUL r/m16 writes both product halves without touching high register words",
    bytes: [0x66, 0xf7, 0xe3],
    initialState: {
      eax: 0xaaaa_ffff,
      ebx: 2,
      edx: 0xbbbb_1234,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: {
      eax: 0xaaaa_fffe,
      edx: 0xbbbb_0001,
      ...multiplyOverflowFlags
    }
  },
  {
    name: "MUL r/m32 writes the full unsigned product to EDX:EAX",
    bytes: [0xf7, 0xe3],
    initialState: {
      eax: 0xffff_ffff,
      ebx: 2,
      edx: 0x1234_5678,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { eax: 0xffff_fffe, edx: 1, ...multiplyOverflowFlags }
  },
  {
    name: "IMUL r/m8 writes a negative signed product to AX",
    bytes: [0xf6, 0xeb],
    initialState: { eax: 0xaaaa_00fe, ebx: 3, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xaaaa_fffa, ...multiplyNoOverflowFlags }
  },
  {
    name: "IMUL r/m32 writes both signed product halves",
    bytes: [0xf7, 0xeb],
    initialState: {
      eax: 0x4000_0000,
      ebx: 2,
      edx: 0x1234_5678,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { eax: 0x8000_0000, edx: 0, ...multiplyOverflowFlags }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of implicitMultiplyCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("IMUL accepts a memory source", async () => {
  const address = 0x2800;

  await assertInstructionCase({
    name: "IMUL EAX by dword memory source",
    bytes: [0x0f, 0xaf, 0x03],
    initialState: { eax: 3, ebx: address, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xffff_fffa, ...multiplyNoOverflowFlags },
    memoryPatches: [{ address, bytes: [0xfe, 0xff, 0xff, 0xff] }],
    expectedMemory: [{ address, bytes: [0xfe, 0xff, 0xff, 0xff] }]
  });
});

test("faulting IMUL source publishes neither destination nor flags", async () => {
  const address = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0xfe, 0xff, 0xff];

  await assertInstructionCase({
    name: "partial dword IMUL read fault",
    bytes: [0x0f, 0xaf, 0x03],
    initialState: { eax: 7, ebx: address, ...allFlagsSet, ...nonStatusFlags },
    expectedCompletion: {
      kind: "cpuException",
      exception: { kind: "PF", linearAddress: address, errorCode: 0 }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{ address, bytes: initialBytes }],
    expectedMemory: [{ address, bytes: initialBytes }]
  });
});

const signExtendCases = [
  {
    name: "CBW extends a positive AL into AX and preserves high EAX",
    bytes: [0x66, 0x98],
    initialState: { eax: 0xaaaa_007f, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xaaaa_007f }
  },
  {
    name: "CBW sign-extends a negative AL into AX and preserves high EAX",
    bytes: [0x66, 0x98],
    initialState: { eax: 0xaaaa_0080, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xaaaa_ff80 }
  },
  {
    name: "CWDE extends a positive AX into EAX",
    bytes: [0x98],
    initialState: { eax: 0xaaaa_7fff, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0x0000_7fff }
  },
  {
    name: "CWDE sign-extends a negative AX into EAX",
    bytes: [0x98],
    initialState: { eax: 0xaaaa_8000, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xffff_8000 }
  },
  {
    name: "CWD writes zero to DX for a positive AX and preserves high EDX",
    bytes: [0x66, 0x99],
    initialState: {
      eax: 0xaaaa_7fff,
      edx: 0xbbbb_1234,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { edx: 0xbbbb_0000 }
  },
  {
    name: "CWD writes all ones to DX for a negative AX and preserves high EDX",
    bytes: [0x66, 0x99],
    initialState: {
      eax: 0xaaaa_8000,
      edx: 0xbbbb_1234,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { edx: 0xbbbb_ffff }
  },
  {
    name: "CDQ writes zero to EDX for a positive EAX",
    bytes: [0x99],
    initialState: {
      eax: 0x7fff_ffff,
      edx: 0x1234_5678,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { edx: 0 }
  },
  {
    name: "CDQ writes all ones to EDX for a negative EAX",
    bytes: [0x99],
    initialState: {
      eax: 0x8000_0000,
      edx: 0x1234_5678,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { edx: 0xffff_ffff }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of signExtendCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

const divideCases = [
  {
    name: "DIV r/m8 writes quotient and remainder to AL and AH",
    bytes: [0xf6, 0xf3],
    initialState: { eax: 0xaaaa_0035, ebx: 6, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xaaaa_0508 }
  },
  {
    name: "DIV r/m16 writes quotient and remainder without touching high register words",
    bytes: [0x66, 0xf7, 0xf3],
    initialState: {
      eax: 0xaaaa_0000,
      ebx: 0x0000_0100,
      edx: 0xbbbb_0001,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { eax: 0xaaaa_0100, edx: 0xbbbb_0000 }
  },
  {
    name: "DIV r/m32 writes quotient and remainder to EAX and EDX",
    bytes: [0xf7, 0xf3],
    initialState: { eax: 0, ebx: 2, edx: 1, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0x8000_0000, edx: 0 }
  },
  {
    name: "IDIV r/m16 produces a positive quotient and remainder",
    bytes: [0x66, 0xf7, 0xfb],
    initialState: {
      eax: 0xaaaa_012c,
      ebx: 7,
      edx: 0xbbbb_0000,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { eax: 0xaaaa_002a, edx: 0xbbbb_0006 }
  },
  {
    name: "IDIV r/m32 keeps the dividend sign on an inexact remainder",
    bytes: [0xf7, 0xfb],
    initialState: {
      eax: 0xffff_fff9,
      ebx: 2,
      edx: 0xffff_ffff,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { eax: 0xffff_fffd, edx: 0xffff_ffff }
  },
  {
    name: "DIV r/m32 accepts the widest fitting unsigned quotient",
    bytes: [0xf7, 0xf3],
    initialState: {
      eax: 0xffff_fffd,
      ebx: 6,
      edx: 5,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { eax: 0xffff_ffff, edx: 3 }
  },
  {
    name: "IDIV r/m8 accepts the positive quotient boundary",
    bytes: [0xf6, 0xfb],
    initialState: { eax: 0xaaaa_04fb, ebx: 10, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xaaaa_057f }
  },
  {
    name: "IDIV r/m8 accepts the negative quotient boundary",
    bytes: [0xf6, 0xfb],
    initialState: { eax: 0xaaaa_fafc, ebx: 10, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0xaaaa_fc80 }
  },
  {
    name: "IDIV r/m16 accepts the positive quotient boundary",
    bytes: [0x66, 0xf7, 0xfb],
    initialState: {
      eax: 0xaaaa_ffff,
      ebx: 2,
      edx: 0xbbbb_0000,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: { eax: 0xaaaa_7fff, edx: 0xbbbb_0001 }
  },
  {
    name: "IDIV r/m32 accepts the positive quotient boundary",
    bytes: [0xf7, 0xfb],
    initialState: { eax: 0xffff_ffff, ebx: 2, edx: 0, ...allFlagsSet, ...nonStatusFlags },
    expectedState: { eax: 0x7fff_ffff, edx: 1 }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of divideCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

const divideErrorCases = [
  {
    name: "DIV by zero raises divide error before any write",
    bytes: [0xf7, 0xf3],
    initialState: {
      eax: 0x1234_5678,
      ebx: 0,
      edx: 0x89ab_cdef,
      ...allFlagsSet,
      ...nonStatusFlags
    }
  },
  {
    name: "DIV quotient overflow raises divide error before any write",
    bytes: [0xf7, 0xf3],
    initialState: { eax: 0, ebx: 5, edx: 5, ...allFlagsSet, ...nonStatusFlags }
  },
  {
    name: "IDIV by zero raises divide error before any write",
    bytes: [0xf7, 0xfb],
    initialState: {
      eax: 0x1234_5678,
      ebx: 0,
      edx: 0x89ab_cdef,
      ...allFlagsSet,
      ...nonStatusFlags
    }
  },
  {
    name: "IDIV dword minimum divided by minus one raises divide error",
    bytes: [0xf7, 0xfb],
    initialState: {
      eax: 0x8000_0000,
      ebx: 0xffff_ffff,
      edx: 0xffff_ffff,
      ...allFlagsSet,
      ...nonStatusFlags
    }
  },
  {
    name: "IDIV word minimum divided by minus one raises divide error",
    bytes: [0x66, 0xf7, 0xfb],
    initialState: {
      eax: 0xaaaa_0000,
      ebx: 0x0000_ffff,
      edx: 0xbbbb_8000,
      ...allFlagsSet,
      ...nonStatusFlags
    }
  },
  {
    name: "IDIV quotient just past the signed range raises divide error",
    bytes: [0xf7, 0xfb],
    initialState: { eax: 0, ebx: 2, edx: 1, ...allFlagsSet, ...nonStatusFlags }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of divideErrorCases) {
  test(entry.name, async () => {
    await assertInstructionCase({
      ...entry,
      expectedCompletion: {
        kind: "cpuException",
        exception: { kind: "DE" }
      },
      expectedEip: startAddress,
      instructionCount: 0
    });
  });
}

test("DIV memory source fault takes priority over divide error", async () => {
  const address = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0, 0, 0];

  await assertInstructionCase({
    name: "partial dword divisor read fault",
    bytes: [0xf7, 0x33],
    initialState: { eax: 0, ebx: address, edx: 1, ...allFlagsSet, ...nonStatusFlags },
    expectedCompletion: {
      kind: "cpuException",
      exception: { kind: "PF", linearAddress: address, errorCode: 0 }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{ address, bytes: initialBytes }],
    expectedMemory: [{ address, bytes: initialBytes }]
  });
});
