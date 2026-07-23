import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { runCompiledInstructions } from "#test/harness/compiled-instruction.js";
import { startAddress } from "#test/support/addresses.js";
import {
  createWasmCpuArchitecturalStateSnapshot,
  type WasmCpuStatusFlag
} from "#test/support/cpu-state.js";
import { guestMemoryMinimumByteLength } from "#memory/constants.js";

type AluFlags = Readonly<Record<WasmCpuStatusFlag, 0 | 1>>;

const initialFlags = {
  CF: 1,
  PF: 0,
  AF: 1,
  ZF: 0,
  SF: 1,
  OF: 1
} as const satisfies AluFlags;

const nonStatusFlags = {
  TF: 1,
  DF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

type RegisterAluCase = Readonly<{
  name: string;
  bytes: readonly number[];
  initialEax: number;
  ebx: number;
  initialCf?: 0 | 1;
  expectedEax: number;
  expectedFlags: AluFlags;
}>;

// Source-to-destination inventory:
// - registerBehaviorCases owns register r/m <- register forms for every
//   binary op and width using fixed architectural outcomes;
// - immediateCases owns accumulator-immediate and grouped r/m-immediate forms;
// - the memory cases own register <- memory and memory <- register forms;
// - CMP/TEST cases own their no-destination-write variants; and
// - unaryCases owns the single r/m read-modify-write family.
const registerBehaviorCases = [
  {
    name: "ADD8 unsigned wrap",
    bytes: [0x00, 0xd8],
    initialEax: 0xaaaa_aaff,
    ebx: 1,
    expectedEax: 0xaaaa_aa00,
    expectedFlags: flags("CF", "PF", "AF", "ZF")
  },
  {
    name: "ADD16 signed overflow",
    bytes: [0x66, 0x01, 0xd8],
    initialEax: 0xaaaa_7fff,
    ebx: 1,
    expectedEax: 0xaaaa_8000,
    expectedFlags: flags("PF", "AF", "SF", "OF")
  },
  {
    name: "ADD32 carry and negative overflow",
    bytes: [0x01, 0xd8],
    initialEax: 0x8000_0000,
    ebx: 0x8000_0000,
    expectedEax: 0,
    expectedFlags: flags("CF", "PF", "ZF", "OF")
  },
  {
    name: "ADC8 carry-in causes signed overflow",
    bytes: [0x10, 0xd8],
    initialEax: 0xaaaa_aa7f,
    ebx: 0,
    initialCf: 1,
    expectedEax: 0xaaaa_aa80,
    expectedFlags: flags("AF", "SF", "OF")
  },
  {
    name: "ADC16 carry-in wraps",
    bytes: [0x66, 0x11, 0xd8],
    initialEax: 0xaaaa_ffff,
    ebx: 0,
    initialCf: 1,
    expectedEax: 0xaaaa_0000,
    expectedFlags: flags("CF", "PF", "AF", "ZF")
  },
  {
    name: "ADC32 carry-in crosses a nibble",
    bytes: [0x11, 0xd8],
    initialEax: 0x0f,
    ebx: 0,
    initialCf: 1,
    expectedEax: 0x10,
    expectedFlags: flags("AF")
  },
  {
    name: "OR8 produces negative even parity",
    bytes: [0x08, 0xd8],
    initialEax: 0xaaaa_aa80,
    ebx: 1,
    expectedEax: 0xaaaa_aa81,
    expectedFlags: flags("PF", "SF")
  },
  {
    name: "OR16 combines disjoint halves",
    bytes: [0x66, 0x09, 0xd8],
    initialEax: 0xaaaa_00ff,
    ebx: 0xff00,
    expectedEax: 0xaaaa_ffff,
    expectedFlags: flags("PF", "SF")
  },
  {
    name: "OR32 produces zero",
    bytes: [0x09, 0xd8],
    initialEax: 0,
    ebx: 0,
    expectedEax: 0,
    expectedFlags: flags("PF", "ZF")
  },
  {
    name: "SBB8 borrow-in wraps",
    bytes: [0x18, 0xd8],
    initialEax: 0xaaaa_aa00,
    ebx: 0,
    initialCf: 1,
    expectedEax: 0xaaaa_aaff,
    expectedFlags: flags("CF", "PF", "AF", "SF")
  },
  {
    name: "SBB16 borrow-in overflows",
    bytes: [0x66, 0x19, 0xd8],
    initialEax: 0xaaaa_8000,
    ebx: 0,
    initialCf: 1,
    expectedEax: 0xaaaa_7fff,
    expectedFlags: flags("PF", "AF", "OF")
  },
  {
    name: "SBB32 consumes its borrow-in",
    bytes: [0x19, 0xd8],
    initialEax: 1,
    ebx: 0,
    initialCf: 1,
    expectedEax: 0,
    expectedFlags: flags("PF", "ZF")
  },
  {
    name: "AND8 clears disjoint bits",
    bytes: [0x20, 0xd8],
    initialEax: 0xaaaa_aaf0,
    ebx: 0x0f,
    expectedEax: 0xaaaa_aa00,
    expectedFlags: flags("PF", "ZF")
  },
  {
    name: "AND16 keeps sign and low bits",
    bytes: [0x66, 0x21, 0xd8],
    initialEax: 0xaaaa_80ff,
    ebx: 0xffff,
    expectedEax: 0xaaaa_80ff,
    expectedFlags: flags("PF", "SF")
  },
  {
    name: "AND32 keeps sign and low bit",
    bytes: [0x21, 0xd8],
    initialEax: 0x8000_0001,
    ebx: 0xffff_ffff,
    expectedEax: 0x8000_0001,
    expectedFlags: flags("SF")
  },
  {
    name: "SUB8 borrow wraps",
    bytes: [0x28, 0xd8],
    initialEax: 0xaaaa_aa00,
    ebx: 1,
    expectedEax: 0xaaaa_aaff,
    expectedFlags: flags("CF", "PF", "AF", "SF")
  },
  {
    name: "SUB16 signed overflow",
    bytes: [0x66, 0x29, 0xd8],
    initialEax: 0xaaaa_8000,
    ebx: 1,
    expectedEax: 0xaaaa_7fff,
    expectedFlags: flags("PF", "AF", "OF")
  },
  {
    name: "SUB32 negative-source overflow",
    bytes: [0x29, 0xd8],
    initialEax: 0x7fff_ffff,
    ebx: 0xffff_ffff,
    expectedEax: 0x8000_0000,
    expectedFlags: flags("CF", "PF", "SF", "OF")
  },
  {
    name: "XOR8 equal operands produce zero",
    bytes: [0x30, 0xd8],
    initialEax: 0xaaaa_aaaa,
    ebx: 0xaa,
    expectedEax: 0xaaaa_aa00,
    expectedFlags: flags("PF", "ZF")
  },
  {
    name: "XOR16 toggles low and sign bits",
    bytes: [0x66, 0x31, 0xd8],
    initialEax: 0xaaaa_8000,
    ebx: 1,
    expectedEax: 0xaaaa_8001,
    expectedFlags: flags("SF")
  },
  {
    name: "XOR32 produces negative even parity",
    bytes: [0x31, 0xd8],
    initialEax: 0x1234_5678,
    ebx: 0x9abc_def0,
    expectedEax: 0x8888_8888,
    expectedFlags: flags("PF", "SF")
  },
  {
    name: "CMP8 signed overflow without a write",
    bytes: [0x38, 0xd8],
    initialEax: 0xaaaa_aa80,
    ebx: 1,
    expectedEax: 0xaaaa_aa80,
    expectedFlags: flags("AF", "OF")
  },
  {
    name: "CMP16 borrow without a write",
    bytes: [0x66, 0x39, 0xd8],
    initialEax: 0xaaaa_0000,
    ebx: 1,
    expectedEax: 0xaaaa_0000,
    expectedFlags: flags("CF", "PF", "AF", "SF")
  },
  {
    name: "CMP32 equality without a write",
    bytes: [0x39, 0xd8],
    initialEax: 5,
    ebx: 5,
    expectedEax: 5,
    expectedFlags: flags("PF", "ZF")
  },
  {
    name: "TEST8 keeps the sign bit without a write",
    bytes: [0x84, 0xd8],
    initialEax: 0xaaaa_aa80,
    ebx: 0xff,
    expectedEax: 0xaaaa_aa80,
    expectedFlags: flags("SF")
  },
  {
    name: "TEST16 keeps only a low bit without a write",
    bytes: [0x66, 0x85, 0xd8],
    initialEax: 0xaaaa_8001,
    ebx: 1,
    expectedEax: 0xaaaa_8001,
    expectedFlags: flags()
  },
  {
    name: "TEST32 disjoint masks produce zero without a write",
    bytes: [0x85, 0xd8],
    initialEax: 0xf0,
    ebx: 0x0f,
    expectedEax: 0xf0,
    expectedFlags: flags("PF", "ZF")
  }
] as const satisfies readonly RegisterAluCase[];

for (const entry of registerBehaviorCases) {
  test(`${entry.name} matches its fixed architectural outcome`, async () => {
    await assertRegisterAluCase(entry);
  });
}

test("ALU destinations truncate at AL, AH, AX, and EAX aliases", async () => {
  const cases: readonly RegisterAluCase[] = [
    {
      name: "ADD AL wraps without changing adjacent EAX bytes",
      bytes: [0x04, 0x01],
      initialEax: 0x1234_56ff,
      ebx: 0,
      expectedEax: 0x1234_5600,
      expectedFlags: flags("CF", "PF", "AF", "ZF")
    },
    {
      name: "ADD AH wraps without changing AL or upper EAX",
      bytes: [0x80, 0xc4, 0x01],
      initialEax: 0x1234_ff78,
      ebx: 0,
      expectedEax: 0x1234_0078,
      expectedFlags: flags("CF", "PF", "AF", "ZF")
    },
    {
      name: "ADD AX wraps without carrying into upper EAX",
      bytes: [0x66, 0x05, 0x01, 0x00],
      initialEax: 0x1234_ffff,
      ebx: 0,
      expectedEax: 0x1234_0000,
      expectedFlags: flags("CF", "PF", "AF", "ZF")
    },
    {
      name: "ADD EAX truncates the full dword result",
      bytes: [0x05, 0x01, 0x00, 0x00, 0x00],
      initialEax: 0xffff_ffff,
      ebx: 0,
      expectedEax: 0,
      expectedFlags: flags("CF", "PF", "AF", "ZF")
    }
  ];

  for (const entry of cases) {
    await assertRegisterAluCase(entry);
  }
});

const immediateCases: readonly RegisterAluCase[] = [
  {
    name: "OR AL, imm8",
    bytes: [0x0c, 0x80],
    initialEax: 0x1234_567f,
    ebx: 0,
    expectedEax: 0x1234_56ff,
    expectedFlags: flags("PF", "SF")
  },
  {
    name: "SBB AX, imm16",
    bytes: [0x66, 0x1d, 0x01, 0x00],
    initialEax: 0x1234_0001,
    ebx: 0,
    initialCf: 1,
    expectedEax: 0x1234_ffff,
    expectedFlags: flags("CF", "PF", "AF", "SF")
  },
  {
    name: "AND EAX, grouped imm32",
    bytes: [0x81, 0xe0, 0x00, 0xff, 0x00, 0xff],
    initialEax: 0xffff_ffff,
    ebx: 0,
    expectedEax: 0xff00_ff00,
    expectedFlags: flags("PF", "SF")
  },
  {
    name: "SUB EAX, sign-extended grouped imm8",
    bytes: [0x83, 0xe8, 0xff],
    initialEax: 1,
    ebx: 0,
    expectedEax: 2,
    expectedFlags: flags("CF", "AF")
  },
  {
    name: "XOR AX, grouped imm16",
    bytes: [0x66, 0x81, 0xf0, 0xff, 0x80],
    initialEax: 0x1234_80ff,
    ebx: 0,
    expectedEax: 0x1234_0000,
    expectedFlags: flags("PF", "ZF")
  },
  {
    name: "ADC EAX, sign-extended grouped imm8",
    bytes: [0x83, 0xd0, 0xff],
    initialEax: 1,
    ebx: 0,
    initialCf: 1,
    expectedEax: 1,
    expectedFlags: flags("CF", "AF")
  },
  {
    name: "CMP EAX, grouped imm32",
    bytes: [0x81, 0xf8, 0x78, 0x56, 0x34, 0x12],
    initialEax: 0x1234_5678,
    ebx: 0,
    expectedEax: 0x1234_5678,
    expectedFlags: flags("PF", "ZF")
  },
  {
    name: "TEST EAX, accumulator imm32",
    bytes: [0xa9, 0x0f, 0x00, 0x00, 0x80],
    initialEax: 0x8000_00f0,
    ebx: 0,
    expectedEax: 0x8000_00f0,
    expectedFlags: flags("PF", "SF")
  }
];

for (const entry of immediateCases) {
  test(`${entry.name} uses the decoded immediate source`, async () => {
    await assertRegisterAluCase(entry);
  });
}

test("ADC and SBB consume both clear and set incoming carry", async () => {
  for (const entry of [
    {
      name: "ADC with CF=0",
      bytes: [0x15, 0x00, 0x00, 0x00, 0x00],
      initialEax: 0xffff_ffff,
      ebx: 0,
      initialCf: 0,
      expectedEax: 0xffff_ffff,
      expectedFlags: flags("PF", "SF")
    },
    {
      name: "ADC with CF=1",
      bytes: [0x15, 0x00, 0x00, 0x00, 0x00],
      initialEax: 0xffff_ffff,
      ebx: 0,
      initialCf: 1,
      expectedEax: 0,
      expectedFlags: flags("CF", "PF", "AF", "ZF")
    },
    {
      name: "SBB with CF=0",
      bytes: [0x1d, 0x00, 0x00, 0x00, 0x00],
      initialEax: 0x8000_0000,
      ebx: 0,
      initialCf: 0,
      expectedEax: 0x8000_0000,
      expectedFlags: flags("PF", "SF")
    },
    {
      name: "SBB with CF=1",
      bytes: [0x1d, 0x00, 0x00, 0x00, 0x00],
      initialEax: 0x8000_0000,
      ebx: 0,
      initialCf: 1,
      expectedEax: 0x7fff_ffff,
      expectedFlags: flags("PF", "AF", "OF")
    }
  ] as const satisfies readonly RegisterAluCase[]) {
    await assertRegisterAluCase(entry);
  }
});

test("logic and TEST apply the project's undefined AF policy as zero", async () => {
  for (const entry of [
    {
      op: "and",
      bytes: [0x21, 0xd8],
      left: 0xffff_ffff,
      right: 0,
      expectedEax: 0,
      expectedFlags: flags("PF", "ZF")
    },
    {
      op: "or",
      bytes: [0x09, 0xd8],
      left: 0x8000_0000,
      right: 1,
      expectedEax: 0x8000_0001,
      expectedFlags: flags("SF")
    },
    {
      op: "xor",
      bytes: [0x31, 0xd8],
      left: 0x55,
      right: 0xaa,
      expectedEax: 0xff,
      expectedFlags: flags("PF")
    },
    {
      op: "test",
      bytes: [0x85, 0xd8],
      left: 0xffff_ffff,
      right: 1,
      expectedEax: 0xffff_ffff,
      expectedFlags: flags()
    }
  ] as const) {
    const initialState = createWasmCpuArchitecturalStateSnapshot({
      eax: entry.left,
      ebx: entry.right,
      ...initialFlags,
      AF: 1,
      ...nonStatusFlags,
      eip: startAddress,
      instructionCount: 7
    });
    const result = await runCompiledInstructions({
      bytes: entry.bytes,
      initialState
    });

    deepStrictEqual(result.completion, {
      kind: "completed",
      targetEip: startAddress + entry.bytes.length
    }, entry.op);
    deepStrictEqual(result.state, {
      ...initialState,
      eax: entry.expectedEax,
      ...entry.expectedFlags,
      eip: startAddress + entry.bytes.length,
      instructionCount: 8
    }, entry.op);
    deepStrictEqual(result.memory, [], entry.op);
  }
});

test("INC and DEC preserve clear and set incoming CF", async () => {
  const cases = [
    {
      name: "INC keeps set CF",
      bytes: [0x41],
      input: 0xffff_ffff,
      initialCf: 1,
      expectedResult: 0,
      expectedFlags: flags("CF", "PF", "AF", "ZF")
    },
    {
      name: "DEC keeps clear CF",
      bytes: [0x49],
      input: 0x8000_0000,
      initialCf: 0,
      expectedResult: 0x7fff_ffff,
      expectedFlags: flags("PF", "AF", "OF")
    }
  ] as const;

  for (const entry of cases) {
    const initialState = createWasmCpuArchitecturalStateSnapshot({
      ecx: entry.input,
      ...initialFlags,
      CF: entry.initialCf,
      ...nonStatusFlags,
      eip: startAddress,
      instructionCount: 7
    });
    const result = await runCompiledInstructions({
      bytes: entry.bytes,
      initialState
    });

    deepStrictEqual(result.completion, {
      kind: "completed",
      targetEip: startAddress + 1
    }, entry.name);
    deepStrictEqual(result.state, {
      ...initialState,
      ecx: entry.expectedResult,
      ...entry.expectedFlags,
      eip: startAddress + 1,
      instructionCount: 8
    }, entry.name);
    deepStrictEqual(result.memory, [], entry.name);
  }
});

const unaryCases = [
  {
    name: "INC AH",
    bytes: [0xfe, 0xc4],
    initialEax: 0x1234_7f56,
    expectedEax: 0x1234_8056,
    expectedFlags: flags("CF", "AF", "SF", "OF")
  },
  {
    name: "DEC AX",
    bytes: [0x66, 0x48],
    initialEax: 0x1234_8000,
    expectedEax: 0x1234_7fff,
    expectedFlags: flags("CF", "PF", "AF", "OF")
  },
  {
    name: "INC EAX",
    bytes: [0x40],
    initialEax: 0xffff_ffff,
    expectedEax: 0,
    expectedFlags: flags("CF", "PF", "AF", "ZF")
  },
  {
    name: "NOT AL",
    bytes: [0xf6, 0xd0],
    initialEax: 0x1234_5655,
    expectedEax: 0x1234_56aa,
    expectedFlags: initialFlags
  },
  {
    name: "NOT AX",
    bytes: [0x66, 0xf7, 0xd0],
    initialEax: 0x1234_55aa,
    expectedEax: 0x1234_aa55,
    expectedFlags: initialFlags
  },
  {
    name: "NOT EAX",
    bytes: [0xf7, 0xd0],
    initialEax: 0x1234_5678,
    expectedEax: 0xedcb_a987,
    expectedFlags: initialFlags
  },
  {
    name: "NEG AL zero",
    bytes: [0xf6, 0xd8],
    initialEax: 0x1234_5600,
    expectedEax: 0x1234_5600,
    expectedFlags: flags("PF", "ZF")
  },
  {
    name: "NEG AX minimum",
    bytes: [0x66, 0xf7, 0xd8],
    initialEax: 0x1234_8000,
    expectedEax: 0x1234_8000,
    expectedFlags: flags("CF", "PF", "SF", "OF")
  },
  {
    name: "NEG EAX",
    bytes: [0xf7, 0xd8],
    initialEax: 1,
    expectedEax: 0xffff_ffff,
    expectedFlags: flags("CF", "PF", "AF", "SF")
  }
] as const;

for (const entry of unaryCases) {
  test(`${entry.name} follows unary result and flag rules`, async () => {
    const initialState = createWasmCpuArchitecturalStateSnapshot({
      eax: entry.initialEax,
      ...initialFlags,
      ...nonStatusFlags,
      eip: startAddress,
      instructionCount: 7
    });
    const result = await runCompiledInstructions({ bytes: entry.bytes, initialState });

    deepStrictEqual(result.completion, {
      kind: "completed",
      targetEip: startAddress + entry.bytes.length
    }, entry.name);
    deepStrictEqual(result.state, {
      ...initialState,
      eax: entry.expectedEax,
      ...entry.expectedFlags,
      eip: startAddress + entry.bytes.length,
      instructionCount: 8
    }, entry.name);
    deepStrictEqual(result.memory, [], entry.name);
  });
}

test("register and memory binary forms read and write the selected owner", async () => {
  const address = 0x2400;
  const readInitial = createWasmCpuArchitecturalStateSnapshot({
    eax: 0x7fff_ffff,
    ebx: address,
    ...initialFlags,
    ...nonStatusFlags,
    eip: startAddress,
    instructionCount: 7
  });
  const readBytes = [0x03, 0x03]; // add eax, [ebx]
  const read = await runCompiledInstructions({
    bytes: readBytes,
    initialState: readInitial,
    memoryPatches: [{ address, bytes: dwordBytes(1) }],
    memoryRanges: [{ address, byteLength: 4 }]
  });

  deepStrictEqual(read.completion, {
    kind: "completed",
    targetEip: startAddress + readBytes.length
  });
  deepStrictEqual(read.state, {
    ...readInitial,
    eax: 0x8000_0000,
    ...flags("PF", "AF", "SF", "OF"),
    eip: startAddress + readBytes.length,
    instructionCount: 8
  });
  deepStrictEqual(read.memory, [{
    address,
    byteLength: 4,
    bytes: dwordBytes(1)
  }]);

  const writeInitial = createWasmCpuArchitecturalStateSnapshot({
    eax: 1,
    ebx: address,
    ...initialFlags,
    ...nonStatusFlags,
    eip: startAddress,
    instructionCount: 7
  });
  const writeBytes = [0x01, 0x03]; // add [ebx], eax
  const write = await runCompiledInstructions({
    bytes: writeBytes,
    initialState: writeInitial,
    memoryPatches: [{ address, bytes: dwordBytes(0xffff_ffff) }],
    memoryRanges: [{ address, byteLength: 4 }]
  });

  deepStrictEqual(write.completion, {
    kind: "completed",
    targetEip: startAddress + writeBytes.length
  });
  deepStrictEqual(write.state, {
    ...writeInitial,
    ...flags("CF", "PF", "AF", "ZF"),
    eip: startAddress + writeBytes.length,
    instructionCount: 8
  });
  deepStrictEqual(write.memory, [{
    address,
    byteLength: 4,
    bytes: dwordBytes(0)
  }]);
});

test("CMP and TEST memory sources publish flags without a destination or memory write", async () => {
  const address = 0x2500;

  for (const entry of [
    {
      op: "cmp",
      bytes: [0x39, 0x03],
      memoryValue: 5,
      eax: 5,
      expectedFlags: flags("PF", "ZF")
    },
    {
      op: "test",
      bytes: [0x85, 0x03],
      memoryValue: 0x8000_0000,
      eax: 0xffff_ffff,
      expectedFlags: flags("PF", "SF")
    }
  ] as const) {
    const initialState = createWasmCpuArchitecturalStateSnapshot({
      eax: entry.eax,
      ebx: address,
      ...initialFlags,
      ...nonStatusFlags,
      eip: startAddress,
      instructionCount: 7
    });
    const result = await runCompiledInstructions({
      bytes: entry.bytes,
      initialState,
      memoryPatches: [{ address, bytes: dwordBytes(entry.memoryValue) }],
      memoryRanges: [{ address, byteLength: 4 }]
    });

    deepStrictEqual(result.completion, {
      kind: "completed",
      targetEip: startAddress + entry.bytes.length
    }, entry.op);
    deepStrictEqual(result.state, {
      ...initialState,
      ...entry.expectedFlags,
      eip: startAddress + entry.bytes.length,
      instructionCount: 8
    }, entry.op);
    deepStrictEqual(result.memory, [{
      address,
      byteLength: 4,
      bytes: dwordBytes(entry.memoryValue)
    }], entry.op);
  }
});

test("faulting ALU source reads publish neither destination nor flag writes", async () => {
  const faultAddress = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0xaa, 0xbb, 0xcc];
  const initialState = createWasmCpuArchitecturalStateSnapshot({
    eax: 0x1234_5678,
    ...initialFlags,
    ...nonStatusFlags,
    eip: startAddress,
    instructionCount: 7
  });
  const result = await runCompiledInstructions({
    bytes: [0x1b, 0x05, ...disp32(faultAddress)], // sbb eax, [disp32]
    initialState,
    memoryPatches: [{ address: faultAddress, bytes: initialBytes }],
    memoryRanges: [{ address: faultAddress, byteLength: initialBytes.length }]
  });

  deepStrictEqual(result.completion, {
    kind: "cpuException",
    exception: {
      kind: "PF",
      linearAddress: faultAddress,
      errorCode: 0
    }
  });
  deepStrictEqual(result.state, initialState);
  deepStrictEqual(result.memory, [{
    address: faultAddress,
    byteLength: 3,
    bytes: initialBytes
  }]);
});

test("faulting ALU read-modify-writes publish neither flags nor guest bytes", async () => {
  const faultAddress = guestMemoryMinimumByteLength - 3;
  const initialBytes = [0xaa, 0xbb, 0xcc];
  const initialState = createWasmCpuArchitecturalStateSnapshot({
    eax: 1,
    CF: 1,
    PF: 0,
    AF: 1,
    ZF: 0,
    SF: 1,
    OF: 1,
    ...nonStatusFlags,
    eip: startAddress,
    instructionCount: 7
  });
  const result = await runCompiledInstructions({
    bytes: [0x11, 0x05, ...disp32(faultAddress)], // adc [disp32], eax
    initialState,
    memoryPatches: [{ address: faultAddress, bytes: initialBytes }],
    memoryRanges: [{ address: faultAddress, byteLength: initialBytes.length }]
  });

  deepStrictEqual(result.completion, {
    kind: "cpuException",
    exception: {
      kind: "PF",
      linearAddress: faultAddress,
      errorCode: 2
    }
  });
  deepStrictEqual(result.state, initialState);
  deepStrictEqual(result.memory, [{
    address: faultAddress,
    byteLength: 3,
    bytes: initialBytes
  }]);
});

async function assertRegisterAluCase(entry: RegisterAluCase): Promise<void> {
  const initialState = createWasmCpuArchitecturalStateSnapshot({
    eax: entry.initialEax,
    ebx: entry.ebx,
    ...initialFlags,
    CF: entry.initialCf ?? 0,
    ...nonStatusFlags,
    eip: startAddress,
    instructionCount: 7
  });
  const result = await runCompiledInstructions({ bytes: entry.bytes, initialState });

  deepStrictEqual(result.completion, {
    kind: "completed",
    targetEip: startAddress + entry.bytes.length
  }, entry.name);
  deepStrictEqual(result.state, {
    ...initialState,
    eax: entry.expectedEax,
    ...entry.expectedFlags,
    eip: startAddress + entry.bytes.length,
    instructionCount: 8
  }, entry.name);
  deepStrictEqual(result.memory, [], entry.name);
}

function flags(...set: readonly WasmCpuStatusFlag[]): AluFlags {
  return {
    CF: set.includes("CF") ? 1 : 0,
    PF: set.includes("PF") ? 1 : 0,
    AF: set.includes("AF") ? 1 : 0,
    ZF: set.includes("ZF") ? 1 : 0,
    SF: set.includes("SF") ? 1 : 0,
    OF: set.includes("OF") ? 1 : 0
  };
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
