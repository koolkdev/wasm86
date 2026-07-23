import { test } from "node:test";

import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import { assertInstructionCase } from "#test/harness/instruction-case.js";
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

test("PUSHAD stores every dword in architectural order and captures original ESP", async () => {
  const stackStart = 0x120;
  const stackImage = dwordsBytes(
    0x7777_7777,
    0x6666_6666,
    0x5555_5555,
    0x0000_0140,
    0x4444_4444,
    0x3333_3333,
    0x2222_2222,
    0x1111_1111
  );

  await assertInstructionCase({
    name: "PUSHAD register image",
    bytes: [0x60],
    initialState: {
      eax: 0x1111_1111,
      ecx: 0x2222_2222,
      edx: 0x3333_3333,
      ebx: 0x4444_4444,
      esp: 0x140,
      ebp: 0x5555_5555,
      esi: 0x6666_6666,
      edi: 0x7777_7777,
      ...allUserFlagsSet
    },
    expectedState: { esp: stackStart },
    memoryPatches: [{
      address: stackStart - 1,
      bytes: [0xaa, ...new Array(stackImage.length).fill(0), 0xbb]
    }],
    expectedMemory: [{
      address: stackStart - 1,
      bytes: [0xaa, ...stackImage, 0xbb]
    }]
  });
});

test("PUSHA stores every word in architectural order and captures original SP", async () => {
  const stackStart = 0x110;
  const stackImage = wordsBytes(
    0x7777,
    0x6666,
    0x5555,
    0x0120,
    0x4444,
    0x3333,
    0x2222,
    0x1111
  );

  await assertInstructionCase({
    name: "PUSHA register image",
    bytes: [0x66, 0x60],
    initialState: {
      eax: 0xaaaa_1111,
      ecx: 0xbbbb_2222,
      edx: 0xcccc_3333,
      ebx: 0xdddd_4444,
      esp: 0x120,
      ebp: 0xeeee_5555,
      esi: 0xffff_6666,
      edi: 0x9999_7777,
      ...allUserFlagsSet
    },
    expectedState: { esp: stackStart },
    memoryPatches: [{
      address: stackStart - 1,
      bytes: [0xaa, ...new Array(stackImage.length).fill(0), 0xbb]
    }],
    expectedMemory: [{
      address: stackStart - 1,
      bytes: [0xaa, ...stackImage, 0xbb]
    }]
  });
});

test("POPAD restores seven dword registers and skips the saved ESP cell", async () => {
  const stackStart = 0x120;
  const stackImage = dwordsBytes(
    0x7777_7777,
    0x6666_6666,
    0x5555_5555,
    0xdead_beef,
    0x4444_4444,
    0x3333_3333,
    0x2222_2222,
    0x1111_1111
  );

  await assertInstructionCase({
    name: "POPAD register image",
    bytes: [0x61],
    initialState: {
      eax: 0xaaaa_aaaa,
      ecx: 0xbbbb_bbbb,
      edx: 0xcccc_cccc,
      ebx: 0xdddd_dddd,
      esp: stackStart,
      ebp: 0xeeee_eeee,
      esi: 0xffff_ffff,
      edi: 0x9999_9999,
      ...allUserFlagsSet
    },
    expectedState: {
      eax: 0x1111_1111,
      ecx: 0x2222_2222,
      edx: 0x3333_3333,
      ebx: 0x4444_4444,
      esp: 0x140,
      ebp: 0x5555_5555,
      esi: 0x6666_6666,
      edi: 0x7777_7777
    },
    memoryPatches: [{ address: stackStart, bytes: stackImage }],
    expectedMemory: [{ address: stackStart, bytes: stackImage }]
  });
});

test("POPA restores seven word aliases and skips the saved SP cell", async () => {
  const stackStart = 0x110;
  const stackImage = wordsBytes(
    0x7777,
    0x6666,
    0x5555,
    0xbeef,
    0x4444,
    0x3333,
    0x2222,
    0x1111
  );

  await assertInstructionCase({
    name: "POPA register image",
    bytes: [0x66, 0x61],
    initialState: {
      eax: 0xaaaa_0000,
      ecx: 0xbbbb_0000,
      edx: 0xcccc_0000,
      ebx: 0xdddd_0000,
      esp: stackStart,
      ebp: 0xeeee_0000,
      esi: 0xffff_0000,
      edi: 0x9999_0000,
      ...allUserFlagsSet
    },
    expectedState: {
      eax: 0xaaaa_1111,
      ecx: 0xbbbb_2222,
      edx: 0xcccc_3333,
      ebx: 0xdddd_4444,
      esp: 0x120,
      ebp: 0xeeee_5555,
      esi: 0xffff_6666,
      edi: 0x9999_7777
    },
    memoryPatches: [{ address: stackStart, bytes: stackImage }],
    expectedMemory: [{ address: stackStart, bytes: stackImage }]
  });
});

test("ENTER level zero saves EBP once before allocating local bytes", async () => {
  const untouchedLocals = new Array(16).fill(0xcc);

  await assertInstructionCase({
    name: "ENTER 16, 0",
    bytes: [0xc8, 0x10, 0x00, 0x00],
    initialState: { esp: 0x180, ebp: 0x1234_5678, ...allUserFlagsSet },
    expectedState: { ebp: 0x17c, esp: 0x16c },
    memoryPatches: [{
      address: 0x16c,
      bytes: [...untouchedLocals, 0, 0, 0, 0]
    }],
    expectedMemory: [{
      address: 0x16c,
      bytes: [...untouchedLocals, ...dwordBytes(0x1234_5678)]
    }]
  });
});

test("ENTER level two copies the enclosing display and appends its new frame", async () => {
  await assertInstructionCase({
    name: "ENTER 4, 2",
    bytes: [0xc8, 0x04, 0x00, 0x02],
    initialState: { esp: 0x120, ebp: 0x180, ...allUserFlagsSet },
    expectedState: { ebp: 0x11c, esp: 0x110 },
    memoryPatches: [
      { address: 0x110, bytes: new Array(16).fill(0xcc) },
      { address: 0x17c, bytes: dwordBytes(0xaaaa_0001) }
    ],
    expectedMemory: [
      {
        address: 0x110,
        bytes: [
          0xcc, 0xcc, 0xcc, 0xcc,
          ...dwordBytes(0x0000_011c),
          ...dwordBytes(0xaaaa_0001),
          ...dwordBytes(0x0000_0180)
        ]
      },
      { address: 0x17c, bytes: dwordBytes(0xaaaa_0001) }
    ]
  });
});

test("ENTER level 31 copies all thirty enclosing display cells", async () => {
  const sourceLowToHigh = [
    0x0000_901d, 0x0000_901c, 0x0000_901b, 0x0000_901a,
    0x0000_9019, 0x0000_9018, 0x0000_9017, 0x0000_9016,
    0x0000_9015, 0x0000_9014, 0x0000_9013, 0x0000_9012,
    0x0000_9011, 0x0000_9010, 0x0000_900f, 0x0000_900e,
    0x0000_900d, 0x0000_900c, 0x0000_900b, 0x0000_900a,
    0x0000_9009, 0x0000_9008, 0x0000_9007, 0x0000_9006,
    0x0000_9005, 0x0000_9004, 0x0000_9003, 0x0000_9002,
    0x0000_9001, 0x0000_9000
  ] as const;

  await assertInstructionCase({
    name: "ENTER 0, 31",
    bytes: [0xc8, 0x00, 0x00, 0x1f],
    initialState: { esp: 0x300, ebp: 0x500, ...allUserFlagsSet },
    expectedState: { ebp: 0x2fc, esp: 0x280 },
    memoryPatches: [{
      address: 0x488,
      bytes: dwordsBytes(...sourceLowToHigh)
    }],
    expectedMemory: [
      {
        address: 0x280,
        bytes: dwordsBytes(
          0x0000_02fc,
          ...sourceLowToHigh,
          0x0000_0500
        )
      },
      {
        address: 0x488,
        bytes: dwordsBytes(...sourceLowToHigh)
      }
    ]
  });
});

test("ENTER masks its nesting level to five bits", async () => {
  await assertInstructionCase({
    name: "ENTER 4, 0x21",
    bytes: [0xc8, 0x04, 0x00, 0x21],
    initialState: { esp: 0x180, ebp: 0x240, ...allUserFlagsSet },
    expectedState: { ebp: 0x17c, esp: 0x174 },
    memoryPatches: [{ address: 0x174, bytes: new Array(12).fill(0xcc) }],
    expectedMemory: [{
      address: 0x174,
      bytes: [
        0xcc, 0xcc, 0xcc, 0xcc,
        ...dwordBytes(0x0000_017c),
        ...dwordBytes(0x0000_0240)
      ]
    }]
  });
});

test("nested ENTER frames expose an outer local through the copied display", async () => {
  const bytes = [
    0xc8, 0x04, 0x00, 0x01,
    0xc7, 0x45, 0xf8, 0x78, 0x56, 0x34, 0x12,
    0xc8, 0x04, 0x00, 0x02,
    0x8b, 0x45, 0xfc,
    0x8b, 0x40, 0xf8
  ];

  await assertInstructionCase({
    name: "two linear ENTER frames and display reads",
    bytes,
    initialState: { esp: 0x300, ...allUserFlagsSet },
    expectedState: { eax: 0x1234_5678, ebp: 0x2f0, esp: 0x2e4 },
    instructionCount: 5,
    expectedMemory: [{
      address: 0x2e4,
      bytes: dwordsBytes(
        0x0000_0000,
        0x0000_02f0,
        0x0000_02fc,
        0x0000_02fc,
        0x1234_5678,
        0x0000_02fc,
        0x0000_0000
      )
    }]
  });
});

test("PUSHA-family writes validate the complete stack image before storing", async () => {
  for (const entry of [
    {
      name: "PUSHAD trailing partial image",
      bytes: [0x60],
      byteLength: 32
    },
    {
      name: "PUSHA trailing partial image",
      bytes: [0x66, 0x60],
      byteLength: 16
    }
  ] as const) {
    const address = guestMemoryMinimumByteLength - entry.byteLength + 1;
    const initialBytes = new Array(entry.byteLength - 1).fill(0x5a);

    await assertInstructionCase({
      name: entry.name,
      bytes: entry.bytes,
      initialState: {
        eax: 0x1111_1111,
        ecx: 0x2222_2222,
        edx: 0x3333_3333,
        ebx: 0x4444_4444,
        esp: guestMemoryMinimumByteLength + 1,
        ebp: 0x5555_5555,
        esi: 0x6666_6666,
        edi: 0x7777_7777,
        ...allUserFlagsSet
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
  }
});

test("POPA-family reads validate the complete stack image before restoring registers", async () => {
  for (const entry of [
    {
      name: "POPAD trailing partial image",
      bytes: [0x61],
      byteLength: 32
    },
    {
      name: "POPA trailing partial image",
      bytes: [0x66, 0x61],
      byteLength: 16
    }
  ] as const) {
    const address = guestMemoryMinimumByteLength - entry.byteLength + 1;
    const initialBytes = new Array(entry.byteLength - 1).fill(0x5a);

    await assertInstructionCase({
      name: entry.name,
      bytes: entry.bytes,
      initialState: {
        eax: 0xaaaa_aaaa,
        ecx: 0xbbbb_bbbb,
        edx: 0xcccc_cccc,
        ebx: 0xdddd_dddd,
        esp: address,
        ebp: 0xeeee_eeee,
        esi: 0xffff_ffff,
        edi: 0x9999_9999,
        ...allUserFlagsSet
      },
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

test("ENTER write preflight leaves state and its trailing bytes unchanged", async () => {
  const address = guestMemoryMinimumByteLength - 2;
  const initialBytes = [0xaa, 0xbb];

  await assertInstructionCase({
    name: "ENTER level-zero trailing partial frame write",
    bytes: [0xc8, 0x00, 0x00, 0x00],
    initialState: {
      esp: guestMemoryMinimumByteLength + 2,
      ebp: 0x1234_5678,
      ...allUserFlagsSet
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

test("ENTER read preflight leaves state and its would-be display stores unchanged", async () => {
  const readAddress = guestMemoryMinimumByteLength - 2;
  const destinationAddress = 0x114;
  const sourceBytes = [0xaa, 0xbb];
  const destinationBytes = new Array(12).fill(0xcc);

  await assertInstructionCase({
    name: "ENTER level-two trailing partial display read",
    bytes: [0xc8, 0x00, 0x00, 0x02],
    initialState: {
      esp: 0x120,
      ebp: guestMemoryMinimumByteLength + 2,
      ...allUserFlagsSet
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: { kind: "PF", linearAddress: readAddress, errorCode: 0 }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [
      { address: readAddress, bytes: sourceBytes },
      { address: destinationAddress, bytes: destinationBytes }
    ],
    expectedMemory: [
      { address: readAddress, bytes: sourceBytes },
      { address: destinationAddress, bytes: destinationBytes }
    ]
  });
});

function wordsBytes(...values: readonly number[]): readonly number[] {
  return values.flatMap(wordBytes);
}

function dwordsBytes(...values: readonly number[]): readonly number[] {
  return values.flatMap(dwordBytes);
}

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
