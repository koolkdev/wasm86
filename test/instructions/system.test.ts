import { test } from "node:test";

import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import {
  assertInstructionCase,
  type InstructionCase
} from "#test/instructions/harness/instruction-case.js";
import { startAddress } from "#test/support/addresses.js";

const preservedState = {
  eax: 0x1122_3344,
  ecx: 0x5566_7788,
  edx: 0x99aa_bbcc,
  ebx: 0xddee_ff00,
  ebp: 0x1234_5678,
  esi: 0x2345_6789,
  edi: 0x3456_789a,
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

const systemCases = [
  {
    name: "9B WAIT falls through without changing architectural state",
    bytes: [0x9b],
    initialState: preservedState
  },
  {
    name: "CD INT reports its immediate vector after completing",
    bytes: [0xcd, 0x2e],
    initialState: preservedState,
    expectedCompletion: { kind: "hostTrap", vector: 0x2e }
  },
  {
    name: "CD INT preserves a zero vector payload",
    bytes: [0xcd, 0x00],
    initialState: preservedState,
    expectedCompletion: { kind: "hostTrap", vector: 0 }
  },
  {
    name: "CD INT preserves an unsigned FF vector payload",
    bytes: [0xcd, 0xff],
    initialState: preservedState,
    expectedCompletion: { kind: "hostTrap", vector: 0xff }
  },
  {
    name: "CC INT3 reports vector 3 after completing",
    bytes: [0xcc],
    initialState: preservedState,
    expectedCompletion: { kind: "hostTrap", vector: 3 }
  },
  {
    name: "CE INTO falls through when OF is clear",
    bytes: [0xce],
    initialState: { ...preservedState, OF: 0 }
  },
  {
    name: "CE INTO reports vector 4 after completing when OF is set",
    bytes: [0xce],
    initialState: { ...preservedState, OF: 1 },
    expectedCompletion: { kind: "hostTrap", vector: 4 }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of systemCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

const movSegmentCases = [
  {
    name: "8E MOV to ES requests a selector load without committing state",
    bytes: [0x8e, 0xc0],
    initialState: {
      ...preservedState,
      eax: 0x1234_5678,
      esSelector: 0x1111
    },
    expectedCompletion: {
      kind: "segmentLoad",
      segment: "es",
      selector: 0x5678
    },
    expectedEip: startAddress,
    instructionCount: 0
  },
  {
    name: "8E MOV to SS requests a zero selector load without committing state",
    bytes: [0x8e, 0xd0],
    initialState: {
      ...preservedState,
      eax: 0xaaaa_0000,
      ssSelector: 0x2222
    },
    expectedCompletion: {
      kind: "segmentLoad",
      segment: "ss",
      selector: 0
    },
    expectedEip: startAddress,
    instructionCount: 0
  },
  {
    name: "8E MOV to DS requests its low-word selector payload",
    bytes: [0x8e, 0xd8],
    initialState: {
      ...preservedState,
      eax: 0xaaaa_1357,
      dsSelector: 0x3333
    },
    expectedCompletion: {
      kind: "segmentLoad",
      segment: "ds",
      selector: 0x1357
    },
    expectedEip: startAddress,
    instructionCount: 0
  },
  {
    name: "66 8E MOV to FS retains restartable selector-load behavior",
    bytes: [0x66, 0x8e, 0xe0],
    initialState: {
      ...preservedState,
      eax: 0xbbbb_2468,
      fsSelector: 0x4444,
      fsBase: 0x2000
    },
    expectedCompletion: {
      kind: "segmentLoad",
      segment: "fs",
      selector: 0x2468
    },
    expectedEip: startAddress,
    instructionCount: 0
  },
  {
    name: "8E MOV to GS preserves an unsigned FFFF selector payload",
    bytes: [0x8e, 0xe8],
    initialState: {
      ...preservedState,
      eax: 0xcccc_ffff,
      gsSelector: 0x5555,
      gsBase: 0x3000
    },
    expectedCompletion: {
      kind: "segmentLoad",
      segment: "gs",
      selector: 0xffff
    },
    expectedEip: startAddress,
    instructionCount: 0
  },
  {
    name: "8E MOV memory source requests a DS selector load",
    bytes: [0x8e, 0x1d, 0x20, 0x00, 0x00, 0x00],
    initialState: { ...preservedState, dsSelector: 0x1111 },
    memoryPatches: [{ address: 0x20, bytes: [0x34, 0x12] }],
    expectedMemory: [{ address: 0x20, bytes: [0x34, 0x12] }],
    expectedCompletion: {
      kind: "segmentLoad",
      segment: "ds",
      selector: 0x1234
    },
    expectedEip: startAddress,
    instructionCount: 0
  },
  {
    name: "8E MOV reads a GS selector from the last valid word",
    bytes: [0x8e, 0x2d, ...disp32(guestMemoryMinimumByteLength - 2)],
    initialState: {
      ...preservedState,
      gsSelector: 0x5555,
      gsBase: 0x3000
    },
    memoryPatches: [{
      address: guestMemoryMinimumByteLength - 2,
      bytes: [0xef, 0xbe]
    }],
    expectedMemory: [{
      address: guestMemoryMinimumByteLength - 2,
      bytes: [0xef, 0xbe]
    }],
    expectedCompletion: {
      kind: "segmentLoad",
      segment: "gs",
      selector: 0xbeef
    },
    expectedEip: startAddress,
    instructionCount: 0
  },
  {
    name: "8E MOV faults on a trailing partial FS selector read",
    bytes: [0x8e, 0x25, ...disp32(guestMemoryMinimumByteLength - 1)],
    initialState: {
      ...preservedState,
      fsSelector: 0x4444,
      fsBase: 0x2000
    },
    memoryPatches: [{
      address: guestMemoryMinimumByteLength - 1,
      bytes: [0x7a]
    }],
    expectedMemory: [{
      address: guestMemoryMinimumByteLength - 1,
      bytes: [0x7a]
    }],
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength - 1,
        errorCode: 0
      }
    },
    expectedEip: startAddress,
    instructionCount: 0
  },
  {
    name: "8E MOV to CS raises #UD before reading its memory source",
    bytes: [0x8e, 0x0d, ...disp32(guestMemoryMinimumByteLength)],
    initialState: { ...preservedState, csSelector: 0x1111 },
    expectedCompletion: {
      kind: "cpuException",
      exception: { kind: "UD" }
    },
    expectedEip: startAddress,
    instructionCount: 0
  }
] as const satisfies readonly InstructionCase[];

for (const entry of movSegmentCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

const popSegments = [
  {
    name: "ES",
    segment: "es",
    dwordBytes: [0x07],
    wordBytes: [0x66, 0x07],
    initialSegmentState: { esSelector: 0x1111 }
  },
  {
    name: "SS",
    segment: "ss",
    dwordBytes: [0x17],
    wordBytes: [0x66, 0x17],
    initialSegmentState: { ssSelector: 0x2222 }
  },
  {
    name: "DS",
    segment: "ds",
    dwordBytes: [0x1f],
    wordBytes: [0x66, 0x1f],
    initialSegmentState: { dsSelector: 0x3333 }
  },
  {
    name: "FS",
    segment: "fs",
    dwordBytes: [0x0f, 0xa1],
    wordBytes: [0x66, 0x0f, 0xa1],
    initialSegmentState: { fsSelector: 0x4444, fsBase: 0x2000 }
  },
  {
    name: "GS",
    segment: "gs",
    dwordBytes: [0x0f, 0xa9],
    wordBytes: [0x66, 0x0f, 0xa9],
    initialSegmentState: { gsSelector: 0x5555, gsBase: 0x3000 }
  }
] as const;

for (const entry of popSegments) {
  test(`POP ${entry.name} reads a dword cell and requests a restartable selector load`, async () => {
    await assertInstructionCase({
      name: `POP ${entry.name} dword stack cell`,
      bytes: entry.dwordBytes,
      initialState: {
        ...preservedState,
        ...entry.initialSegmentState,
        esp: 0x200
      },
      expectedCompletion: {
        kind: "segmentLoad",
        segment: entry.segment,
        selector: 0x1234
      },
      expectedEip: startAddress,
      instructionCount: 0,
      memoryPatches: [{ address: 0x200, bytes: [0x34, 0x12, 0xcd, 0xab] }],
      expectedMemory: [{ address: 0x200, bytes: [0x34, 0x12, 0xcd, 0xab] }]
    });
  });

  test(`POP ${entry.name} reads a word cell and requests a restartable selector load`, async () => {
    await assertInstructionCase({
      name: `POP ${entry.name} word stack cell`,
      bytes: entry.wordBytes,
      initialState: {
        ...preservedState,
        ...entry.initialSegmentState,
        esp: 0x200
      },
      expectedCompletion: {
        kind: "segmentLoad",
        segment: entry.segment,
        selector: 0xbeef
      },
      expectedEip: startAddress,
      instructionCount: 0,
      memoryPatches: [{ address: 0x200, bytes: [0xef, 0xbe] }],
      expectedMemory: [{ address: 0x200, bytes: [0xef, 0xbe] }]
    });
  });
}

const popSegmentBoundaryCases = [
  {
    name: "POP FS dword cell succeeds at the last valid dword",
    bytes: [0x0f, 0xa1],
    initialState: {
      ...preservedState,
      esp: guestMemoryMinimumByteLength - 4,
      fsSelector: 0x4444,
      fsBase: 0x2000
    },
    expectedCompletion: {
      kind: "segmentLoad",
      segment: "fs",
      selector: 0x2468
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{
      address: guestMemoryMinimumByteLength - 4,
      bytes: [0x68, 0x24, 0xaa, 0xbb]
    }],
    expectedMemory: [{
      address: guestMemoryMinimumByteLength - 4,
      bytes: [0x68, 0x24, 0xaa, 0xbb]
    }]
  },
  {
    name: "66 POP GS word cell succeeds at the last valid word",
    bytes: [0x66, 0x0f, 0xa9],
    initialState: {
      ...preservedState,
      esp: guestMemoryMinimumByteLength - 2,
      gsSelector: 0x5555,
      gsBase: 0x3000
    },
    expectedCompletion: {
      kind: "segmentLoad",
      segment: "gs",
      selector: 0x1357
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{
      address: guestMemoryMinimumByteLength - 2,
      bytes: [0x57, 0x13]
    }],
    expectedMemory: [{
      address: guestMemoryMinimumByteLength - 2,
      bytes: [0x57, 0x13]
    }]
  },
  {
    name: "POP DS dword cell faults on a trailing partial read",
    bytes: [0x1f],
    initialState: {
      ...preservedState,
      esp: guestMemoryMinimumByteLength - 2,
      dsSelector: 0x3333
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength - 2,
        errorCode: 0
      }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{
      address: guestMemoryMinimumByteLength - 2,
      bytes: [0x34, 0x12]
    }],
    expectedMemory: [{
      address: guestMemoryMinimumByteLength - 2,
      bytes: [0x34, 0x12]
    }]
  },
  {
    name: "66 POP ES word cell faults on a trailing partial read",
    bytes: [0x66, 0x07],
    initialState: {
      ...preservedState,
      esp: guestMemoryMinimumByteLength - 1,
      esSelector: 0x1111
    },
    expectedCompletion: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength - 1,
        errorCode: 0
      }
    },
    expectedEip: startAddress,
    instructionCount: 0,
    memoryPatches: [{
      address: guestMemoryMinimumByteLength - 1,
      bytes: [0x34]
    }],
    expectedMemory: [{
      address: guestMemoryMinimumByteLength - 1,
      bytes: [0x34]
    }]
  }
] as const satisfies readonly InstructionCase[];

for (const entry of popSegmentBoundaryCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

function disp32(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}
