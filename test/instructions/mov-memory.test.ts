import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { PageFaultErrorCode, pageFault } from "#core/exceptions.js";
import {
  runCompiledInstructions,
  type CompiledInstructionCompletion
} from "#test/harness/compiled-instruction.js";
import { startAddress } from "#test/support/addresses.js";
import {
  createWasmCpuStateSnapshot,
  type WasmCpuStateInit,
  type WasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { guestMemoryMinimumByteLength } from "#memory/constants.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

type SuccessfulMemoryCase = Readonly<{
  name: string;
  bytes: readonly number[];
  initialState?: WasmCpuStateInit;
  expectedState?: Partial<WasmCpuStateSnapshot>;
  memoryPatches?: readonly MemoryPatch[];
  expectedMemory?: readonly MemorySnapshot[];
}>;

type MemoryPatch = Readonly<{
  address: number;
  bytes: readonly number[];
}>;

type MemorySnapshot = MemoryPatch & Readonly<{
  byteLength: number;
}>;

test("compiled MOV ModRM memory forms cover 8-, 16-, and 32-bit reads", async () => {
  const address = 0x2000;
  const cases: readonly SuccessfulMemoryCase[] = [
    {
      name: "byte",
      bytes: [0x8a, 0x43, 0x04],
      initialState: { eax: 0xaaaa_aa00, ebx: address - 4 },
      expectedState: { eax: 0xaaaa_aa7f },
      memoryPatches: [{ address, bytes: [0x7f] }],
      expectedMemory: [memory(address, [0x7f])]
    },
    {
      name: "word",
      bytes: [0x66, 0x8b, 0x43, 0x04],
      initialState: { eax: 0xaaaa_0000, ebx: address - 4 },
      expectedState: { eax: 0xaaaa_beef },
      memoryPatches: [{ address, bytes: wordBytes(0xbeef) }],
      expectedMemory: [memory(address, wordBytes(0xbeef))]
    },
    {
      name: "dword",
      bytes: [0x8b, 0x43, 0x04],
      initialState: { eax: 0, ebx: address - 4 },
      expectedState: { eax: 0xc001_cafe },
      memoryPatches: [{ address, bytes: dwordBytes(0xc001_cafe) }],
      expectedMemory: [memory(address, dwordBytes(0xc001_cafe))]
    },
    {
      name: "absolute disp32",
      bytes: [0x8b, 0x05, ...disp32(address)],
      expectedState: { eax: 0xfeed_beef },
      memoryPatches: [{ address, bytes: dwordBytes(0xfeed_beef) }],
      expectedMemory: [memory(address, dwordBytes(0xfeed_beef))]
    }
  ];

  for (const entry of cases) {
    await assertSuccessfulMemoryCase(entry);
  }
});

test("compiled MOV ModRM memory forms cover exact 8-, 16-, and 32-bit writes", async () => {
  const address = 0x2100;
  const cases: readonly SuccessfulMemoryCase[] = [
    {
      name: "byte",
      bytes: [0x88, 0x43, 0x04],
      initialState: { eax: 0x1234_5678, ebx: address - 4 },
      memoryPatches: [{ address: address - 1, bytes: [0xaa, 0, 0xbb] }],
      expectedMemory: [memory(address - 1, [0xaa, 0x78, 0xbb])]
    },
    {
      name: "word",
      bytes: [0x66, 0x89, 0x43, 0x04],
      initialState: { eax: 0x1234_5678, ebx: address - 4 },
      memoryPatches: [{ address: address - 1, bytes: [0xaa, 0, 0, 0xbb] }],
      expectedMemory: [memory(address - 1, [0xaa, 0x78, 0x56, 0xbb])]
    },
    {
      name: "dword",
      bytes: [0x89, 0x43, 0x04],
      initialState: { eax: 0x1234_5678, ebx: address - 4 },
      memoryPatches: [{ address: address - 1, bytes: [0xaa, 0, 0, 0, 0, 0xbb] }],
      expectedMemory: [memory(address - 1, [0xaa, 0x78, 0x56, 0x34, 0x12, 0xbb])]
    }
  ];

  for (const entry of cases) {
    await assertSuccessfulMemoryCase(entry);
  }
});

test("compiled MOV C7 stores immediate words and dwords to memory", async () => {
  const address = 0x2200;
  const cases: readonly SuccessfulMemoryCase[] = [
    {
      name: "word",
      bytes: [0x66, 0xc7, 0x43, 0x04, 0xef, 0xbe],
      initialState: { ebx: address - 4 },
      memoryPatches: [{ address: address - 1, bytes: [0xaa, 0, 0, 0xbb] }],
      expectedMemory: [memory(address - 1, [0xaa, 0xef, 0xbe, 0xbb])]
    },
    {
      name: "dword",
      bytes: [0xc7, 0x43, 0x04, 0x78, 0x56, 0x34, 0x12],
      initialState: { ebx: address - 4 },
      memoryPatches: [{ address: address - 1, bytes: [0xaa, 0, 0, 0, 0, 0xbb] }],
      expectedMemory: [memory(address - 1, [0xaa, 0x78, 0x56, 0x34, 0x12, 0xbb])]
    }
  ];

  for (const entry of cases) {
    await assertSuccessfulMemoryCase(entry);
  }
});

test("compiled MOV moffs forms cover direct 8-, 16-, and 32-bit reads and writes", async () => {
  const readAddress = 0x2300;
  const writeAddress = 0x2400;
  const cases: readonly SuccessfulMemoryCase[] = [
    {
      name: "read byte",
      bytes: [0xa0, ...disp32(readAddress)],
      initialState: { eax: 0xaaaa_aa00 },
      expectedState: { eax: 0xaaaa_aa7f },
      memoryPatches: [{ address: readAddress, bytes: [0x7f] }],
      expectedMemory: [memory(readAddress, [0x7f])]
    },
    {
      name: "read word",
      bytes: [0x66, 0xa1, ...disp32(readAddress)],
      initialState: { eax: 0xaaaa_0000 },
      expectedState: { eax: 0xaaaa_beef },
      memoryPatches: [{ address: readAddress, bytes: wordBytes(0xbeef) }],
      expectedMemory: [memory(readAddress, wordBytes(0xbeef))]
    },
    {
      name: "read dword",
      bytes: [0xa1, ...disp32(readAddress)],
      expectedState: { eax: 0xc001_cafe },
      memoryPatches: [{ address: readAddress, bytes: dwordBytes(0xc001_cafe) }],
      expectedMemory: [memory(readAddress, dwordBytes(0xc001_cafe))]
    },
    {
      name: "write byte",
      bytes: [0xa2, ...disp32(writeAddress)],
      initialState: { eax: 0x1234_5678 },
      memoryPatches: [{ address: writeAddress - 1, bytes: [0xaa, 0, 0xbb] }],
      expectedMemory: [memory(writeAddress - 1, [0xaa, 0x78, 0xbb])]
    },
    {
      name: "write word",
      bytes: [0x66, 0xa3, ...disp32(writeAddress)],
      initialState: { eax: 0x1234_5678 },
      memoryPatches: [{ address: writeAddress - 1, bytes: [0xaa, 0, 0, 0xbb] }],
      expectedMemory: [memory(writeAddress - 1, [0xaa, 0x78, 0x56, 0xbb])]
    },
    {
      name: "write dword",
      bytes: [0xa3, ...disp32(writeAddress)],
      initialState: { eax: 0x1234_5678 },
      memoryPatches: [{ address: writeAddress - 1, bytes: [0xaa, 0, 0, 0, 0, 0xbb] }],
      expectedMemory: [memory(writeAddress - 1, [0xaa, 0x78, 0x56, 0x34, 0x12, 0xbb])]
    }
  ];

  for (const entry of cases) {
    await assertSuccessfulMemoryCase(entry);
  }
});

test("compiled MOVZX and MOVSX extend byte and word memory sources", async () => {
  const address = 0x2500;
  const cases: readonly SuccessfulMemoryCase[] = [
    {
      name: "MOVZX byte to dword",
      bytes: [0x0f, 0xb6, 0x03],
      initialState: { eax: 0xffff_ffff, ebx: address },
      expectedState: { eax: 0xfe },
      memoryPatches: [{ address, bytes: [0xfe] }],
      expectedMemory: [memory(address, [0xfe])]
    },
    {
      name: "MOVZX word to dword",
      bytes: [0x0f, 0xb7, 0x03],
      initialState: { eax: 0xffff_ffff, ebx: address },
      expectedState: { eax: 0x80ff },
      memoryPatches: [{ address, bytes: wordBytes(0x80ff) }],
      expectedMemory: [memory(address, wordBytes(0x80ff))]
    },
    {
      name: "MOVZX byte to word",
      bytes: [0x66, 0x0f, 0xb6, 0x03],
      initialState: { eax: 0xaaaa_ffff, ebx: address },
      expectedState: { eax: 0xaaaa_00fe },
      memoryPatches: [{ address, bytes: [0xfe] }],
      expectedMemory: [memory(address, [0xfe])]
    },
    {
      name: "MOVSX byte to dword",
      bytes: [0x0f, 0xbe, 0x03],
      initialState: { ebx: address },
      expectedState: { eax: 0xffff_ff80 },
      memoryPatches: [{ address, bytes: [0x80] }],
      expectedMemory: [memory(address, [0x80])]
    },
    {
      name: "MOVSX word to dword",
      bytes: [0x0f, 0xbf, 0x03],
      initialState: { ebx: address },
      expectedState: { eax: 0xffff_8001 },
      memoryPatches: [{ address, bytes: wordBytes(0x8001) }],
      expectedMemory: [memory(address, wordBytes(0x8001))]
    },
    {
      name: "MOVSX byte to word",
      bytes: [0x66, 0x0f, 0xbe, 0x03],
      initialState: { eax: 0xaaaa_0000, ebx: address },
      expectedState: { eax: 0xaaaa_ff80 },
      memoryPatches: [{ address, bytes: [0x80] }],
      expectedMemory: [memory(address, [0x80])]
    }
  ];

  for (const entry of cases) {
    await assertSuccessfulMemoryCase(entry);
  }
});

test("compiled MOV stores a segment selector as exactly one word", async () => {
  const address = 0x2600;

  await assertSuccessfulMemoryCase({
    name: "GS selector word store",
    bytes: [0x8c, 0x2b],
    initialState: { ebx: address, gsSelector: 0xabcd },
    memoryPatches: [{ address: address - 1, bytes: [0x11, 0x22, 0x33, 0x44] }],
    expectedMemory: [memory(address - 1, [0x11, 0xcd, 0xab, 0x44])]
  });
});

test("compiled MOV applies effective, default, and overridden segments", async () => {
  const cases: readonly SuccessfulMemoryCase[] = [
    {
      name: "FS override on ModRM base",
      bytes: [0x64, 0x8b, 0x03],
      initialState: { ebx: 0x20, fsBase: 0x1000 },
      expectedState: { eax: 0x1234_5678 },
      memoryPatches: [{ address: 0x1020, bytes: dwordBytes(0x1234_5678) }],
      expectedMemory: [memory(0x1020, dwordBytes(0x1234_5678))]
    },
    {
      name: "GS override on moffs",
      bytes: [0x65, 0xa3, ...disp32(0x30)],
      initialState: { eax: 0xcafe_babe, gsBase: 0x2000 },
      memoryPatches: [{ address: 0x202f, bytes: [0xaa, 0, 0, 0, 0, 0xbb] }],
      expectedMemory: [memory(0x202f, [0xaa, 0xbe, 0xba, 0xfe, 0xca, 0xbb])]
    },
    {
      name: "FS override on no-base disp32",
      bytes: [0x64, 0x8b, 0x05, ...disp32(0x30)],
      initialState: { fsBase: 0x1000 },
      expectedState: { eax: 0xfeed_face },
      memoryPatches: [{ address: 0x1030, bytes: dwordBytes(0xfeed_face) }],
      expectedMemory: [memory(0x1030, dwordBytes(0xfeed_face))]
    },
    {
      name: "EBP default SS uses the flat effective offset",
      bytes: [0x8b, 0x45, 0],
      initialState: { ebp: 0x20, dsBase: 0x1000, ssBase: 0x3000 },
      expectedState: { eax: 0x2222_2222 },
      memoryPatches: [{ address: 0x20, bytes: dwordBytes(0x2222_2222) }],
      expectedMemory: [memory(0x20, dwordBytes(0x2222_2222))]
    },
    {
      name: "ESP default SS uses the flat effective offset",
      bytes: [0x8b, 0x04, 0x24],
      initialState: { esp: 0x30, dsBase: 0x1000, ssBase: 0x3000 },
      expectedState: { eax: 0x4444_4444 },
      memoryPatches: [{ address: 0x30, bytes: dwordBytes(0x4444_4444) }],
      expectedMemory: [memory(0x30, dwordBytes(0x4444_4444))]
    },
    {
      name: "no-base ModRM default DS uses the flat displacement",
      bytes: [0x8b, 0x05, ...disp32(0x30)],
      initialState: { dsBase: 0x1000, ssBase: 0x3000 },
      expectedState: { eax: 0x5555_5555 },
      memoryPatches: [{ address: 0x30, bytes: dwordBytes(0x5555_5555) }],
      expectedMemory: [memory(0x30, dwordBytes(0x5555_5555))]
    },
    {
      name: "moffs default DS uses the flat offset",
      bytes: [0xa1, ...disp32(0x40)],
      initialState: { dsBase: 0x1000, ssBase: 0x3000 },
      expectedState: { eax: 0x7777_7777 },
      memoryPatches: [{ address: 0x40, bytes: dwordBytes(0x7777_7777) }],
      expectedMemory: [memory(0x40, dwordBytes(0x7777_7777))]
    },
    {
      name: "DS override on EBP uses the flat effective offset",
      bytes: [0x3e, 0x8b, 0x45, 0],
      initialState: { ebp: 0x20, dsBase: 0x1000, ssBase: 0x3000 },
      expectedState: { eax: 0x9999_9999 },
      memoryPatches: [{ address: 0x20, bytes: dwordBytes(0x9999_9999) }],
      expectedMemory: [memory(0x20, dwordBytes(0x9999_9999))]
    }
  ];

  for (const entry of cases) {
    await assertSuccessfulMemoryCase(entry);
  }
});

test("compiled MOV accepts the last valid boundary address for each access width", async () => {
  for (const width of [8, 16, 32] as const) {
    const byteLength = width / 8;
    const address = guestMemoryMinimumByteLength - byteLength;
    const value = 0x1234_5678;
    const expectedBytes = dwordBytes(value).slice(0, byteLength);

    await assertSuccessfulMemoryCase({
      name: `${width}-bit boundary read`,
      bytes: movReadDisp32Bytes(width, address),
      initialState: { eax: 0, dsBase: 0 },
      expectedState: { eax: width === 8 ? 0x78 : width === 16 ? 0x5678 : value },
      memoryPatches: [{ address, bytes: expectedBytes }],
      expectedMemory: [memory(address, expectedBytes)]
    });
    await assertSuccessfulMemoryCase({
      name: `${width}-bit boundary write`,
      bytes: movWriteDisp32Bytes(width, address),
      initialState: { eax: value, dsBase: 0 },
      memoryPatches: [{ address, bytes: expectedBytes.map(() => 0) }],
      expectedMemory: [memory(address, expectedBytes)]
    });
  }
});

test("compiled MOV read guards report exact 1-, 2-, and 4-byte fault ranges", async () => {
  for (const width of [8, 16, 32] as const) {
    const faultAddress = guestMemoryMinimumByteLength - width / 8 + 1;

    await assertFaultingMemoryCase({
      name: `${width}-bit read fault`,
      bytes: movReadDisp32Bytes(width, faultAddress),
      initialState: { eax: 0xaaaa_aaaa, dsBase: 0 },
      expectedExit: pageFaultStop(faultAddress, 0)
    });
  }
});

test("compiled MOV write guards fault before state or memory changes", async () => {
  for (const width of [8, 16, 32] as const) {
    const byteLength = width / 8;
    const faultAddress = guestMemoryMinimumByteLength - byteLength + 1;
    const observedAddress = Math.max(0, faultAddress - 1);
    const initialBytes = Array.from(
      { length: guestMemoryMinimumByteLength - observedAddress },
      (_, index) => 0xa0 + index
    );

    await assertFaultingMemoryCase({
      name: `${width}-bit write fault`,
      bytes: movWriteDisp32Bytes(width, faultAddress),
      initialState: { eax: 0x1234_5678, dsBase: 0 },
      expectedExit: pageFaultStop(faultAddress, PageFaultErrorCode.WRITE),
      memoryPatches: [{ address: observedAddress, bytes: initialBytes }],
      expectedMemory: [memory(observedAddress, initialBytes)]
    });
  }
});

test("faulting compiled moffs reads and writes preserve instruction-start state and memory", async () => {
  const faultAddress = guestMemoryMinimumByteLength - 2;
  const observedAddress = faultAddress - 2;
  const initialBytes = [0xaa, 0xbb, 0xcc, 0xdd];

  await assertFaultingMemoryCase({
    name: "moffs dword read fault",
    bytes: [0xa1, ...disp32(faultAddress)],
    initialState: { eax: 0xaaaa_aaaa, dsBase: 0 },
    expectedExit: pageFaultStop(faultAddress, 0),
    memoryPatches: [{ address: observedAddress, bytes: initialBytes }],
    expectedMemory: [memory(observedAddress, initialBytes)]
  });
  await assertFaultingMemoryCase({
    name: "moffs dword write fault",
    bytes: [0xa3, ...disp32(faultAddress)],
    initialState: { eax: 0x1234_5678, dsBase: 0 },
    expectedExit: pageFaultStop(faultAddress, PageFaultErrorCode.WRITE),
    memoryPatches: [{ address: observedAddress, bytes: initialBytes }],
    expectedMemory: [memory(observedAddress, initialBytes)]
  });
});

test("faulting compiled segment-selector store reports a word write before committing", async () => {
  const faultAddress = guestMemoryMinimumByteLength - 1;
  const initialBytes = [0xaa];

  await assertFaultingMemoryCase({
    name: "segment selector word write fault",
    bytes: [0x8c, 0x2b],
    initialState: { ebx: faultAddress, gsSelector: 0xabcd },
    expectedExit: pageFaultStop(faultAddress, PageFaultErrorCode.WRITE),
    memoryPatches: [{ address: faultAddress, bytes: initialBytes }],
    expectedMemory: [memory(faultAddress, initialBytes)]
  });
});

async function assertSuccessfulMemoryCase(entry: SuccessfulMemoryCase): Promise<void> {
  const initialState = createWasmCpuStateSnapshot({
    ...allFlagsSet,
    eip: startAddress,
    instructionCount: 7,
    ...entry.initialState
  });
  const result = await runCompiledInstructions({
    bytes: entry.bytes,
    initialState,
    ...(entry.memoryPatches === undefined ? {} : { memoryPatches: entry.memoryPatches }),
    ...(entry.expectedMemory === undefined ? {} : { memoryRanges: entry.expectedMemory })
  });

  deepStrictEqual(result.completion, completion(startAddress + entry.bytes.length), entry.name);
  deepStrictEqual(result.state, {
    ...initialState,
    ...entry.expectedState,
    eip: startAddress + entry.bytes.length,
    instructionCount: initialState.instructionCount + 1
  }, entry.name);
  deepStrictEqual(result.memory, entry.expectedMemory ?? [], entry.name);
}

async function assertFaultingMemoryCase(
  entry: Omit<SuccessfulMemoryCase, "expectedState"> & Readonly<{
    expectedExit: CompiledInstructionCompletion;
  }>
): Promise<void> {
  const initialState = createWasmCpuStateSnapshot({
    ...allFlagsSet,
    eip: startAddress,
    instructionCount: 7,
    ...entry.initialState
  });
  const result = await runCompiledInstructions({
    bytes: entry.bytes,
    initialState,
    ...(entry.memoryPatches === undefined ? {} : { memoryPatches: entry.memoryPatches }),
    ...(entry.expectedMemory === undefined ? {} : { memoryRanges: entry.expectedMemory })
  });

  deepStrictEqual(result.completion, entry.expectedExit, entry.name);
  deepStrictEqual(result.state, initialState, entry.name);
  deepStrictEqual(result.memory, entry.expectedMemory ?? [], entry.name);
}

function completion(targetEip: number): CompiledInstructionCompletion {
  return { kind: "linkStub", targetEip };
}

function pageFaultStop(address: number, errorCode: number): CompiledInstructionCompletion {
  return { kind: "cpuException", exception: pageFault(address, errorCode) };
}

function memory(address: number, bytes: readonly number[]): MemorySnapshot {
  return { address, byteLength: bytes.length, bytes };
}

function movReadDisp32Bytes(width: 8 | 16 | 32, address: number): readonly number[] {
  switch (width) {
    case 8:
      return [0x8a, 0x05, ...disp32(address)];
    case 16:
      return [0x66, 0x8b, 0x05, ...disp32(address)];
    case 32:
      return [0x8b, 0x05, ...disp32(address)];
  }
}

function movWriteDisp32Bytes(width: 8 | 16 | 32, address: number): readonly number[] {
  switch (width) {
    case 8:
      return [0x88, 0x05, ...disp32(address)];
    case 16:
      return [0x66, 0x89, 0x05, ...disp32(address)];
    case 32:
      return [0x89, 0x05, ...disp32(address)];
  }
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

function disp32(value: number): readonly number[] {
  return dwordBytes(value);
}
