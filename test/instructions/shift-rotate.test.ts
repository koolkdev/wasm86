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
  OF: 0
} as const;

const nonStatusFlags = {
  TF: 1,
  DF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

const shiftCases = [
  {
    name: "SHL r/m32 by one",
    bytes: [0xd1, 0xe3],
    initialState: { ebx: 0x4000_0000, ...allFlagsSet, ...nonStatusFlags },
    expectedState: {
      ebx: 0x8000_0000,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 0,
      SF: 1,
      OF: 1
    }
  },
  {
    name: "SHR r/m32 masks the CL count",
    bytes: [0xd3, 0xeb],
    initialState: { ebx: 0x8000_0000, ecx: 0x21, ...allFlagsSet, ...nonStatusFlags },
    expectedState: {
      ebx: 0x4000_0000,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 1
    }
  },
  {
    name: "SAR r/m16 preserves the high register word",
    bytes: [0x66, 0xc1, 0xfb, 0x04],
    initialState: { ebx: 0x1234_8000, ...allFlagsSet, ...nonStatusFlags },
    expectedState: {
      ebx: 0x1234_f800,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 0,
      SF: 1,
      OF: 0
    }
  },
  {
    name: "SHLD r/m32 shifts source bits into the destination",
    bytes: [0x0f, 0xa4, 0xcb, 0x04],
    initialState: {
      ebx: 0x1234_5678,
      ecx: 0x9abc_def0,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: {
      ebx: 0x2345_6789,
      CF: 1,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "SHRD r/m16 preserves both high register words",
    bytes: [0x66, 0x0f, 0xad, 0xd3],
    initialState: {
      ebx: 0xaaaa_1234,
      edx: 0xbbbb_abcd,
      ecx: 4,
      ...allFlagsSet,
      ...nonStatusFlags
    },
    expectedState: {
      ebx: 0xaaaa_d123,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 1,
      OF: 0
    }
  },
  {
    name: "count-one SHLD defines overflow",
    bytes: [0x0f, 0xa4, 0xd8, 0x01],
    initialState: { eax: 0x4000_0000, ebx: 0x8000_0000, ...allFlagsSet },
    expectedState: {
      eax: 0x8000_0001,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 1,
      OF: 1
    }
  },
  {
    name: "count-one SHRD defines overflow",
    bytes: [0x0f, 0xac, 0xd8, 0x01],
    initialState: { eax: 0x8000_0001, ebx: 0, ...allFlagsSet },
    expectedState: {
      eax: 0x4000_0000,
      CF: 1,
      PF: 1,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 1
    }
  },
  {
    name: "zero shift count preserves destination and flags",
    bytes: [0xd3, 0xeb],
    initialState: { ebx: 0x1234_5678, ecx: 0, ...mixedFlags, ...nonStatusFlags }
  },
  {
    name: "masked-zero shift count preserves destination and flags",
    bytes: [0xd3, 0xeb],
    initialState: { ebx: 0x1234_5678, ecx: 0x20, ...mixedFlags, ...nonStatusFlags }
  },
  {
    name: "zero double-shift count preserves destination and flags",
    bytes: [0x0f, 0xa5, 0xd8],
    initialState: {
      eax: 0x1234_5678,
      ebx: 0x9abc_def0,
      ecx: 0,
      ...mixedFlags,
      ...nonStatusFlags
    }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of shiftCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

const preservedRotateFlags = {
  PF: 1,
  AF: 0,
  ZF: 1,
  SF: 0
} as const;

const rotateCases = [
  {
    name: "ROL r/m8 by one",
    bytes: [0xd0, 0xc0],
    initialState: {
      eax: 0xaaaa_0081,
      ...preservedRotateFlags,
      CF: 0,
      OF: 0,
      ...nonStatusFlags
    },
    expectedState: { eax: 0xaaaa_0003, CF: 1, OF: 1 }
  },
  {
    name: "ROL r/m32 by CL",
    bytes: [0xd3, 0xc3],
    initialState: {
      ebx: 0x1234_5678,
      ecx: 4,
      ...preservedRotateFlags,
      CF: 1,
      OF: 1,
      ...nonStatusFlags
    },
    expectedState: { ebx: 0x2345_6781, CF: 1, OF: 0 }
  },
  {
    name: "ROR r/m16 preserves the high register word",
    bytes: [0x66, 0xd1, 0xc8],
    initialState: {
      eax: 0xaaaa_0001,
      ...preservedRotateFlags,
      CF: 0,
      OF: 0,
      ...nonStatusFlags
    },
    expectedState: { eax: 0xaaaa_8000, CF: 1, OF: 1 }
  },
  {
    name: "nonzero full-width ROL updates carry and applies the undefined overflow policy",
    bytes: [0xc0, 0xc0, 0x08],
    initialState: {
      eax: 0xaaaa_0081,
      ...preservedRotateFlags,
      CF: 0,
      OF: 1,
      ...nonStatusFlags
    },
    expectedState: { CF: 1, OF: 0 }
  },
  {
    name: "RCL consumes clear carry",
    bytes: [0xd0, 0xd3],
    initialState: {
      ebx: 0xaaaa_0080,
      ...preservedRotateFlags,
      CF: 0,
      OF: 0,
      ...nonStatusFlags
    },
    expectedState: { ebx: 0xaaaa_0000, CF: 1, OF: 1 }
  },
  {
    name: "RCL consumes set carry",
    bytes: [0xd0, 0xd3],
    initialState: {
      ebx: 0xaaaa_0000,
      ...preservedRotateFlags,
      CF: 1,
      OF: 1,
      ...nonStatusFlags
    },
    expectedState: { ebx: 0xaaaa_0001, CF: 0, OF: 0 }
  },
  {
    name: "RCR consumes clear carry",
    bytes: [0xd1, 0xd8],
    initialState: {
      eax: 1,
      ...preservedRotateFlags,
      CF: 0,
      OF: 0,
      ...nonStatusFlags
    },
    expectedState: { eax: 0, CF: 1, OF: 0 }
  },
  {
    name: "RCR consumes set carry",
    bytes: [0xd1, 0xd8],
    initialState: {
      eax: 0,
      ...preservedRotateFlags,
      CF: 1,
      OF: 1,
      ...nonStatusFlags
    },
    expectedState: { eax: 0x8000_0000, CF: 0, OF: 1 }
  },
  {
    name: "through-carry full cycle preserves value and carry",
    bytes: [0xc0, 0xd0, 0x09],
    initialState: {
      eax: 0xaaaa_0012,
      ...preservedRotateFlags,
      CF: 1,
      OF: 1,
      ...nonStatusFlags
    },
    expectedState: { OF: 0 }
  },
  {
    name: "zero rotate count preserves destination and every flag",
    bytes: [0xd3, 0xcb],
    initialState: {
      ebx: 0x1234_5678,
      ecx: 0,
      ...mixedFlags,
      ...nonStatusFlags
    }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of rotateCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("rotate memory destination commits the full read-modify-write", async () => {
  const address = 0x2400;

  await assertInstructionCase({
    name: "ROL dword memory destination",
    bytes: [0xd1, 0x03],
    initialState: {
      ebx: address,
      ...preservedRotateFlags,
      CF: 0,
      OF: 0,
      ...nonStatusFlags
    },
    expectedState: { CF: 1, OF: 1 },
    memoryPatches: [{ address, bytes: [0x01, 0x00, 0x00, 0x80] }],
    expectedMemory: [{ address, bytes: [0x03, 0x00, 0x00, 0x00] }]
  });
});

test("faulting rotate memory destination publishes neither state nor bytes", async () => {
  const address = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0x01, 0x00, 0x00];

  await assertInstructionCase({
    name: "partial dword ROL write fault",
    bytes: [0xd1, 0x03],
    initialState: {
      ebx: address,
      ...preservedRotateFlags,
      CF: 1,
      OF: 1,
      ...nonStatusFlags
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
