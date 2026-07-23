import { test } from "node:test";

import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import {
  assertInstructionCase,
  type InstructionCase
} from "#test/harness/instruction-case.js";
import { startAddress } from "#test/support/addresses.js";

const allUserFlagsSet = {
  CF: 1,
  PF: 1,
  AF: 1,
  ZF: 1,
  SF: 1,
  TF: 1,
  DF: 1,
  OF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

const pushCases = [
  {
    name: "PUSH EAX stores one dword below ESP",
    bytes: [0x50],
    initialState: { eax: 0x1122_3344, esp: 0x104, ...allUserFlagsSet },
    expectedState: { esp: 0x100 },
    memoryPatches: [{ address: 0xff, bytes: [0xaa, 0, 0, 0, 0, 0xbb] }],
    expectedMemory: [{ address: 0xff, bytes: [0xaa, 0x44, 0x33, 0x22, 0x11, 0xbb] }]
  },
  {
    name: "PUSH AX stores one word and preserves the register's upper half",
    bytes: [0x66, 0x50],
    initialState: { eax: 0x1122_3344, esp: 0x102, ...allUserFlagsSet },
    expectedState: { esp: 0x100 },
    memoryPatches: [{ address: 0xff, bytes: [0xaa, 0, 0, 0xbb] }],
    expectedMemory: [{ address: 0xff, bytes: [0xaa, 0x44, 0x33, 0xbb] }]
  },
  {
    name: "PUSH imm8 sign-extends into a dword stack cell",
    bytes: [0x6a, 0xff],
    initialState: { esp: 0x104, ...allUserFlagsSet },
    expectedState: { esp: 0x100 },
    memoryPatches: [{ address: 0x100, bytes: [0, 0, 0, 0] }],
    expectedMemory: [{ address: 0x100, bytes: [0xff, 0xff, 0xff, 0xff] }]
  },
  {
    name: "PUSH imm16 stores its literal word",
    bytes: [0x66, 0x68, 0x34, 0x12],
    initialState: { esp: 0x102, ...allUserFlagsSet },
    expectedState: { esp: 0x100 },
    memoryPatches: [{ address: 0x100, bytes: [0, 0] }],
    expectedMemory: [{ address: 0x100, bytes: [0x34, 0x12] }]
  },
  {
    name: "PUSH imm8 sign-extends into a word stack cell",
    bytes: [0x66, 0x6a, 0x80],
    initialState: { esp: 0x102, ...allUserFlagsSet },
    expectedState: { esp: 0x100 },
    memoryPatches: [{ address: 0x100, bytes: [0, 0] }],
    expectedMemory: [{ address: 0x100, bytes: [0x80, 0xff] }]
  }
] as const satisfies readonly InstructionCase[];

for (const entry of pushCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("PUSH [ESP] reads its source before allocating the destination cell", async () => {
  await assertInstructionCase({
    name: "PUSH dword [ESP]",
    bytes: [0xff, 0x34, 0x24],
    initialState: { esp: 0x104, ...allUserFlagsSet },
    expectedState: { esp: 0x100 },
    memoryPatches: [{
      address: 0x100,
      bytes: [...dwordBytes(0), ...dwordBytes(0x5566_7788)]
    }],
    expectedMemory: [{
      address: 0x100,
      bytes: [...dwordBytes(0x5566_7788), ...dwordBytes(0x5566_7788)]
    }]
  });
});

const popRegisterCases = [
  {
    name: "POP EAX loads a dword then increments ESP",
    bytes: [0x58],
    initialState: { eax: 0xaaaa_aaaa, esp: 0x100, ...allUserFlagsSet },
    expectedState: { eax: 0x5566_7788, esp: 0x104 },
    memoryPatches: [{ address: 0x100, bytes: dwordBytes(0x5566_7788) }],
    expectedMemory: [{ address: 0x100, bytes: dwordBytes(0x5566_7788) }]
  },
  {
    name: "POP AX loads a word and preserves upper EAX",
    bytes: [0x66, 0x58],
    initialState: { eax: 0xaaaa_0000, esp: 0x100, ...allUserFlagsSet },
    expectedState: { eax: 0xaaaa_beef, esp: 0x102 },
    memoryPatches: [{ address: 0x100, bytes: [0xef, 0xbe] }],
    expectedMemory: [{ address: 0x100, bytes: [0xef, 0xbe] }]
  },
  {
    name: "POP ESP applies the destination write after the stack increment",
    bytes: [0x5c],
    initialState: { esp: 0x100, ...allUserFlagsSet },
    expectedState: { esp: 0x220 },
    memoryPatches: [{ address: 0x100, bytes: dwordBytes(0x220) }],
    expectedMemory: [{ address: 0x100, bytes: dwordBytes(0x220) }]
  },
  {
    name: "POP SP applies its low-word destination after the stack increment",
    bytes: [0x66, 0x5c],
    initialState: { esp: 0x0100, ...allUserFlagsSet },
    expectedState: { esp: 0x0220 },
    memoryPatches: [{ address: 0x0100, bytes: [0x20, 0x02] }],
    expectedMemory: [{ address: 0x0100, bytes: [0x20, 0x02] }]
  }
] as const satisfies readonly InstructionCase[];

for (const entry of popRegisterCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("POP memory destinations use incremented ESP when computing their address", async () => {
  await assertInstructionCase({
    name: "POP dword [ESP]",
    bytes: [0x8f, 0x04, 0x24],
    initialState: { esp: 0x100, ...allUserFlagsSet },
    expectedState: { esp: 0x104 },
    memoryPatches: [{
      address: 0x100,
      bytes: [...dwordBytes(0x5566_7788), ...dwordBytes(0)]
    }],
    expectedMemory: [{
      address: 0x100,
      bytes: [...dwordBytes(0x5566_7788), ...dwordBytes(0x5566_7788)]
    }]
  });

  await assertInstructionCase({
    name: "POP word [ESP + 8]",
    bytes: [0x66, 0x8f, 0x44, 0x24, 0x08],
    initialState: { esp: 0x100, ...allUserFlagsSet },
    expectedState: { esp: 0x102 },
    memoryPatches: [{
      address: 0x100,
      bytes: [0xef, 0xbe, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }],
    expectedMemory: [{
      address: 0x100,
      bytes: [
        0xef, 0xbe,
        0, 0, 0, 0,
        0, 0, 0, 0,
        0xef, 0xbe
      ]
    }]
  });
});

test("segment PUSH stores the selector in the selected stack-cell width", async () => {
  await assertInstructionCase({
    name: "PUSH FS dword cell",
    bytes: [0x0f, 0xa0],
    initialState: { esp: 0x104, fsSelector: 0x2345, fsBase: 0x1000, ...allUserFlagsSet },
    expectedState: { esp: 0x100 },
    memoryPatches: [{ address: 0xff, bytes: [0xaa, 0, 0, 0, 0, 0xbb] }],
    expectedMemory: [{ address: 0xff, bytes: [0xaa, 0x45, 0x23, 0, 0, 0xbb] }]
  });

  await assertInstructionCase({
    name: "PUSH GS word cell",
    bytes: [0x66, 0x0f, 0xa8],
    initialState: { esp: 0x102, gsSelector: 0xabcd, gsBase: 0x2000, ...allUserFlagsSet },
    expectedState: { esp: 0x100 },
    memoryPatches: [{ address: 0xff, bytes: [0xaa, 0, 0, 0xbb] }],
    expectedMemory: [{ address: 0xff, bytes: [0xaa, 0xcd, 0xab, 0xbb] }]
  });
});

test("LEAVE reads the saved frame before publishing EBP and ESP", async () => {
  await assertInstructionCase({
    name: "LEAVE with aliased frame and stack pointers",
    bytes: [0xc9],
    initialState: { ebp: 0x100, esp: 0x100, ...allUserFlagsSet },
    expectedState: { ebp: 0x5566_7788, esp: 0x104 },
    memoryPatches: [{ address: 0x100, bytes: dwordBytes(0x5566_7788) }],
    expectedMemory: [{ address: 0x100, bytes: dwordBytes(0x5566_7788) }]
  });
});

test("PUSHFD and PUSHF store exact user-visible EFLAGS images", async () => {
  await assertInstructionCase({
    name: "PUSHFD all supported user flags",
    bytes: [0x9c],
    initialState: { esp: 0x104, ...allUserFlagsSet },
    expectedState: { esp: 0x100 },
    memoryPatches: [{ address: 0x100, bytes: dwordBytes(0) }],
    expectedMemory: [{ address: 0x100, bytes: dwordBytes(0x0024_4fd7) }]
  });

  await assertInstructionCase({
    name: "PUSHF low supported user flags",
    bytes: [0x66, 0x9c],
    initialState: { esp: 0x102, ...allUserFlagsSet },
    expectedState: { esp: 0x100 },
    memoryPatches: [{ address: 0x100, bytes: [0, 0] }],
    expectedMemory: [{ address: 0x100, bytes: [0xd7, 0x4f] }]
  });
});

test("POPFD ignores privileged image bits while updating supported user flags", async () => {
  const privilegedOnly = (1 << 9) | (3 << 12) | (1 << 16) | (1 << 17) | (1 << 19) | (1 << 20);

  await assertInstructionCase({
    name: "POPFD privileged-only image",
    bytes: [0x9d],
    initialState: { esp: 0x100, ...allUserFlagsSet },
    expectedState: {
      esp: 0x104,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      TF: 0,
      DF: 0,
      OF: 0,
      NT: 0,
      AC: 0,
      ID: 0
    },
    memoryPatches: [{ address: 0x100, bytes: dwordBytes(privilegedOnly) }],
    expectedMemory: [{ address: 0x100, bytes: dwordBytes(privilegedOnly) }]
  });
});

test("POPF updates low flags while preserving AC and ID", async () => {
  const privilegedOnly = (1 << 9) | (3 << 12);

  await assertInstructionCase({
    name: "POPF privileged-only low image",
    bytes: [0x66, 0x9d],
    initialState: { esp: 0x100, ...allUserFlagsSet },
    expectedState: {
      esp: 0x102,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      TF: 0,
      DF: 0,
      OF: 0,
      NT: 0,
      AC: 1,
      ID: 1
    },
    memoryPatches: [{ address: 0x100, bytes: wordBytes(privilegedOnly) }],
    expectedMemory: [{ address: 0x100, bytes: wordBytes(privilegedOnly) }]
  });
});

test("stack write faults leave instruction-start state and bytes unchanged", async () => {
  await assertInstructionCase({
    name: "PUSH FS wrapping dword write fault",
    bytes: [0x0f, 0xa0],
    initialState: { esp: 2, fsSelector: 0x2345, ...allUserFlagsSet },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: 0xffff_fffe,
        errorCode: 2
      }
    },
    expectedEip: startAddress,
    instructionCount: 0
  });

  const destination = guestMemoryMinimumByteLength - 3;
  const stackAddress = 0x300;
  const stackBytes = dwordBytes(0x5566_7788);
  const destinationBytes = [0xaa, 0xbb, 0xcc];

  await assertInstructionCase({
    name: "POP dword memory destination write fault",
    bytes: [0x8f, 0x03],
    initialState: { ebx: destination, esp: stackAddress, ...allUserFlagsSet },
    expectedCompletion: {
      kind: "cpuException",
      exception: { kind: "PF", linearAddress: destination, errorCode: 2 }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [
      { address: stackAddress, bytes: stackBytes },
      { address: destination, bytes: destinationBytes }
    ],
    expectedMemory: [
      { address: stackAddress, bytes: stackBytes },
      { address: destination, bytes: destinationBytes }
    ]
  });
});

test("stack read faults leave instruction-start state unchanged", async () => {
  const address = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0x11, 0x22, 0x33];

  for (const entry of [
    {
      name: "POP EAX trailing partial read",
      bytes: [0x58],
      initialState: { esp: address }
    },
    {
      name: "LEAVE trailing partial frame read",
      bytes: [0xc9],
      initialState: { esp: 0x100, ebp: address }
    },
    {
      name: "POP DS trailing partial dword read",
      bytes: [0x1f],
      initialState: { esp: address, dsSelector: 0x2222 }
    }
  ] as const) {
    await assertInstructionCase({
      ...entry,
      initialState: { ...entry.initialState, ...allUserFlagsSet },
      expectedCompletion: {
        kind: "cpuException",
        exception: { kind: "PF", linearAddress: address, errorCode: 0 }
      },
      expectedEip: startAddress,
      instructionCount: 0,
      memoryPatches: [{ address, bytes: initialBytes }],
      expectedMemory: [{ address, bytes: initialBytes }]
    });
  }
});

test("a prior instruction remains committed when a later stack access faults", async () => {
  await assertInstructionCase({
    name: "ADD followed by faulting PUSHFD",
    bytes: [0x83, 0xc0, 0x01, 0x9c],
    initialState: { eax: 0xffff_ffff, esp: 2 },
    expectedState: {
      eax: 0,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 0,
      OF: 0
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: 0xffff_fffe,
        errorCode: 2
      }
    },
    expectedEip: startAddress + 3,
    instructionCount: 1
  });
});

function wordBytes(value: number): readonly number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function dwordBytes(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}
