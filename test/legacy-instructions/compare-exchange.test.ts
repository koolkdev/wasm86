import { PageFaultErrorCode, pageFault } from "#core/exceptions.js";
import { startAddress } from "#test/support/addresses.js";
import type { InstructionFixture } from "#test/support/instruction-fixture.js";
import { registerInstructionFixtures } from "./support.js";

const trap = [0xcd, 0x2e] as const;
const pushfdPopEsi = [0x9c, 0x5e] as const;
const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;
const mixedFlags = { CF: 1, PF: 0, AF: 1, ZF: 0, SF: 1, OF: 1 } as const;

const fixtures = [
  {
    name: "cmpxchg32-register-success/pushfd-trap",
    bytes: [0x0f, 0xb1, 0xd9, ...pushfdPopEsi, ...trap],
    initialState: {
      eax: 5,
      ebx: 9,
      ecx: 5,
      esp: 0x80,
      ...allFlagsSet,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 5,
        ebx: 9,
        ecx: 9,
        esi: flagsImage({ PF: 1, ZF: 1 }),
        esp: 0x80,
        eip: startAddress + 7,
        instructionCount: 4
      }
    }
  },
  {
    name: "cmpxchg32-memory-failure/pushfd-trap",
    bytes: [0x0f, 0xb1, 0x1d, 0x20, 0x00, 0x00, 0x00, ...pushfdPopEsi, ...trap],
    initialState: {
      eax: 7,
      ebx: 9,
      esp: 0x80,
      ...allFlagsSet,
      eip: startAddress
    },
    initialMemory: [{ address: 0x20, bytes: dwordBytes(5) }],
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 5,
        ebx: 9,
        esi: flagsImage({}),
        esp: 0x80,
        eip: startAddress + 11,
        instructionCount: 4
      },
      memory: [{ address: 0x20, bytes: dwordBytes(5) }]
    }
  },
  {
    name: "xadd32-register/pushfd-trap",
    bytes: [0x0f, 0xc1, 0xd8, ...pushfdPopEsi, ...trap],
    initialState: {
      eax: 5,
      ebx: 7,
      esp: 0x80,
      ...allFlagsSet,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 12,
        ebx: 5,
        esi: flagsImage({ PF: 1 }),
        esp: 0x80,
        eip: startAddress + 7,
        instructionCount: 4
      }
    }
  },
  {
    name: "xadd32-same-register/pushfd-trap",
    bytes: [0x0f, 0xc1, 0xc0, ...pushfdPopEsi, ...trap],
    initialState: {
      eax: 0x8000_0000,
      esp: 0x80,
      ...allFlagsSet,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0,
        esi: flagsImage({ CF: 1, PF: 1, ZF: 1, OF: 1 }),
        esp: 0x80,
        eip: startAddress + 7,
        instructionCount: 4
      }
    }
  },
  {
    name: "xadd32-memory/pushfd-trap",
    bytes: [0x0f, 0xc1, 0x1d, 0x20, 0x00, 0x00, 0x00, ...pushfdPopEsi, ...trap],
    initialState: {
      ebx: 7,
      esp: 0x80,
      ...allFlagsSet,
      eip: startAddress
    },
    initialMemory: [{ address: 0x20, bytes: dwordBytes(5) }],
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        ebx: 5,
        esi: flagsImage({ PF: 1 }),
        esp: 0x80,
        eip: startAddress + 11,
        instructionCount: 4
      },
      memory: [{ address: 0x20, bytes: dwordBytes(12) }]
    }
  },
  {
    name: "cmpxchg8b-success/trap",
    bytes: [0x0f, 0xc7, 0x0d, 0x20, 0x00, 0x00, 0x00, ...trap],
    initialState: {
      eax: 0x1111_1111,
      edx: 0x2222_2222,
      ebx: 0x3333_3333,
      ecx: 0x4444_4444,
      ...mixedFlags,
      eip: startAddress
    },
    initialMemory: [{ address: 0x20, bytes: [...dwordBytes(0x1111_1111), ...dwordBytes(0x2222_2222)] }],
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0x1111_1111,
        edx: 0x2222_2222,
        ebx: 0x3333_3333,
        ecx: 0x4444_4444,
        ...mixedFlags,
        ZF: 1,
        eip: startAddress + 9,
        instructionCount: 2
      },
      memory: [{ address: 0x20, bytes: [...dwordBytes(0x3333_3333), ...dwordBytes(0x4444_4444)] }]
    }
  },
  {
    name: "cmpxchg8b-failure/trap",
    bytes: [0x0f, 0xc7, 0x0d, 0x28, 0x00, 0x00, 0x00, ...trap],
    initialState: {
      eax: 0x9999_9999,
      edx: 0x2222_2222,
      ebx: 0x3333_3333,
      ecx: 0x4444_4444,
      ...allFlagsSet,
      eip: startAddress
    },
    initialMemory: [{ address: 0x28, bytes: [...dwordBytes(0x1111_1111), ...dwordBytes(0x2222_2222)] }],
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0x1111_1111,
        edx: 0x2222_2222,
        ebx: 0x3333_3333,
        ecx: 0x4444_4444,
        ...allFlagsSet,
        ZF: 0,
        eip: startAddress + 9,
        instructionCount: 2
      },
      memory: [{ address: 0x28, bytes: [...dwordBytes(0x1111_1111), ...dwordBytes(0x2222_2222)] }]
    }
  },
  {
    name: "cmpxchg32-memory-fault",
    bytes: [0x0f, 0xb1, 0x1d, 0xfe, 0xff, 0x00, 0x00],
    initialState: {
      eax: 5,
      ebx: 9,
      ...allFlagsSet,
      eip: startAddress
    },
    expected: {
      stop: { kind: "cpuException", exception: pageFault(0xfffe, PageFaultErrorCode.WRITE) },
      state: {
        eax: 5,
        ebx: 9,
        ...allFlagsSet,
        eip: startAddress,
        instructionCount: 0
      }
    }
  },
  {
    name: "cmpxchg8b-memory-fault",
    bytes: [0x0f, 0xc7, 0x0d, 0xfc, 0xff, 0x00, 0x00],
    initialState: {
      eax: 0x1111_1111,
      edx: 0x2222_2222,
      ebx: 0x3333_3333,
      ecx: 0x4444_4444,
      ...mixedFlags,
      eip: startAddress
    },
    expected: {
      stop: { kind: "cpuException", exception: pageFault(0xfffc, PageFaultErrorCode.WRITE) },
      state: {
        eax: 0x1111_1111,
        edx: 0x2222_2222,
        ebx: 0x3333_3333,
        ecx: 0x4444_4444,
        ...mixedFlags,
        eip: startAddress,
        instructionCount: 0
      }
    }
  }
] as const satisfies readonly InstructionFixture[];

registerInstructionFixtures(fixtures);

function flagsImage(flags: Readonly<Partial<Record<"CF" | "PF" | "AF" | "ZF" | "SF" | "OF", 1>>>): number {
  return (
    0x202 |
    (flags.CF === 1 ? 1 << 0 : 0) |
    (flags.PF === 1 ? 1 << 2 : 0) |
    (flags.AF === 1 ? 1 << 4 : 0) |
    (flags.ZF === 1 ? 1 << 6 : 0) |
    (flags.SF === 1 ? 1 << 7 : 0) |
    (flags.OF === 1 ? 1 << 11 : 0)
  ) >>> 0;
}

function dwordBytes(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}
