import { pageFault } from "#core/exceptions.js";
import { startAddress } from "#test/support/addresses.js";
import type { InstructionFixture } from "#test/support/instruction-fixture.js";
import { registerInstructionFixtures } from "./support.js";

const trap = [0xcd, 0x2e] as const;
const bitPreservedFlags = { PF: 0, AF: 1, ZF: 0, SF: 1, OF: 1 } as const;

const fixtures = [
  {
    name: "bt-register-offset/trap",
    bytes: [0x0f, 0xa3, 0xc8, ...trap],
    initialState: {
      eax: 0x10,
      ecx: 36,
      CF: 0,
      ...bitPreservedFlags,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0x10,
        ecx: 36,
        CF: 1,
        ...bitPreservedFlags,
        eip: startAddress + 5,
        instructionCount: 2
      }
    }
  },
  {
    name: "bts-register-offset/trap",
    bytes: [0x0f, 0xab, 0xc8, ...trap],
    initialState: {
      eax: 0,
      ecx: 33,
      CF: 1,
      ...bitPreservedFlags,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 2,
        ecx: 33,
        CF: 0,
        ...bitPreservedFlags,
        eip: startAddress + 5,
        instructionCount: 2
      }
    }
  },
  {
    name: "btr-register-offset/trap",
    bytes: [0x0f, 0xb3, 0xc8, ...trap],
    initialState: {
      eax: 2,
      ecx: 33,
      CF: 0,
      ...bitPreservedFlags,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0,
        ecx: 33,
        CF: 1,
        ...bitPreservedFlags,
        eip: startAddress + 5,
        instructionCount: 2
      }
    }
  },
  {
    name: "btc-register-offset/trap",
    bytes: [0x0f, 0xbb, 0xc8, ...trap],
    initialState: {
      eax: 0,
      ecx: 33,
      CF: 1,
      ...bitPreservedFlags,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 2,
        ecx: 33,
        CF: 0,
        ...bitPreservedFlags,
        eip: startAddress + 5,
        instructionCount: 2
      }
    }
  },
  {
    name: "bt16-register-offset/trap",
    bytes: [0x66, 0x0f, 0xa3, 0xd0, ...trap],
    initialState: {
      eax: 0xaaaa_8000,
      edx: 0x1f,
      CF: 0,
      ...bitPreservedFlags,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0xaaaa_8000,
        edx: 0x1f,
        CF: 1,
        ...bitPreservedFlags,
        eip: startAddress + 6,
        instructionCount: 2
      }
    }
  },
  {
    name: "bts-memory-immediate-unadjusted/trap",
    bytes: [0x0f, 0xba, 0x2d, 0x20, 0x00, 0x00, 0x00, 36, ...trap],
    initialState: {
      CF: 1,
      ...bitPreservedFlags,
      eip: startAddress
    },
    initialMemory: [{ address: 0x20, bytes: [0, 0, 0, 0] }],
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        CF: 0,
        ...bitPreservedFlags,
        eip: startAddress + 10,
        instructionCount: 2
      },
      memory: [{ address: 0x20, bytes: [0x10, 0, 0, 0] }]
    }
  },
  {
    name: "btr-memory-negative-register-offset-below-ea/trap",
    bytes: [0x0f, 0xb3, 0x08, ...trap],
    initialState: {
      eax: 0x24,
      ecx: 0xffff_ffff,
      CF: 0,
      ...bitPreservedFlags,
      eip: startAddress
    },
    initialMemory: [{ address: 0x20, bytes: [0, 0, 0, 0x80] }],
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0x24,
        ecx: 0xffff_ffff,
        CF: 1,
        ...bitPreservedFlags,
        eip: startAddress + 5,
        instructionCount: 2
      },
      memory: [{ address: 0x20, bytes: [0, 0, 0, 0] }]
    }
  },
  {
    name: "btc-memory-negative-register-offset-below-ea/trap",
    bytes: [0x0f, 0xbb, 0x08, ...trap],
    initialState: {
      eax: 0x24,
      ecx: 0xffff_ffff,
      CF: 1,
      ...bitPreservedFlags,
      eip: startAddress
    },
    initialMemory: [{ address: 0x20, bytes: [0, 0, 0, 0] }],
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0x24,
        ecx: 0xffff_ffff,
        CF: 0,
        ...bitPreservedFlags,
        eip: startAddress + 5,
        instructionCount: 2
      },
      memory: [{ address: 0x20, bytes: [0, 0, 0, 0x80] }]
    }
  },
  {
    name: "bt-memory-negative-offset-adjusted-address-in-range/trap",
    bytes: [0x0f, 0xa3, 0x08, ...trap],
    initialState: {
      eax: 0x1_0000,
      ecx: 0xffff_ffe0,
      CF: 0,
      ...bitPreservedFlags,
      eip: startAddress
    },
    initialMemory: [{ address: 0xfffc, bytes: [1, 0, 0, 0] }],
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0x1_0000,
        ecx: 0xffff_ffe0,
        CF: 1,
        ...bitPreservedFlags,
        eip: startAddress + 5,
        instructionCount: 2
      },
      memory: [{ address: 0xfffc, bytes: [1, 0, 0, 0] }]
    }
  },
  {
    name: "bt-memory-negative-offset-faults-at-adjusted-address",
    bytes: [0x0f, 0xa3, 0x08],
    initialState: {
      eax: 0,
      ecx: 0xffff_ffe0,
      CF: 1,
      ...bitPreservedFlags,
      eip: startAddress
    },
    expected: {
      stop: { kind: "cpuException", exception: pageFault(0xffff_fffc, 0) },
      state: {
        eax: 0,
        ecx: 0xffff_ffe0,
        CF: 1,
        ...bitPreservedFlags,
        eip: startAddress,
        instructionCount: 0
      }
    }
  },
  {
    name: "bsf32-nonzero/trap",
    bytes: [0x0f, 0xbc, 0xc3, ...trap],
    initialState: {
      eax: 0xaaaa_5555,
      ebx: 0x120,
      CF: 1,
      PF: 0,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 5,
        ebx: 0x120,
        ...scanFlags(5, 0),
        eip: startAddress + 5,
        instructionCount: 2
      }
    }
  },
  {
    name: "bsf32-zero-preserves-destination/trap",
    bytes: [0x0f, 0xbc, 0xc3, ...trap],
    initialState: {
      eax: 0xaaaa_5555,
      ebx: 0,
      CF: 1,
      PF: 0,
      AF: 1,
      ZF: 0,
      SF: 1,
      OF: 1,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0xaaaa_5555,
        ebx: 0,
        ...scanFlags(0, 1),
        eip: startAddress + 5,
        instructionCount: 2
      }
    }
  },
  {
    name: "bsf16-nonzero/trap",
    bytes: [0x66, 0x0f, 0xbc, 0xc3, ...trap],
    initialState: {
      eax: 0xaaaa_ffff,
      ebx: 0x0100,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0xaaaa_0008,
        ebx: 0x0100,
        ...scanFlags(8, 0),
        eip: startAddress + 6,
        instructionCount: 2
      }
    }
  },
  {
    name: "bsf32-memory-source-nonzero/trap",
    bytes: [0x0f, 0xbc, 0x05, 0x20, 0x00, 0x00, 0x00, ...trap],
    initialState: {
      eax: 0xaaaa_5555,
      CF: 1,
      PF: 0,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1,
      eip: startAddress
    },
    initialMemory: [{ address: 0x20, bytes: [0x20, 0x01, 0, 0] }],
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 5,
        ...scanFlags(5, 0),
        eip: startAddress + 9,
        instructionCount: 2
      },
      memory: [{ address: 0x20, bytes: [0x20, 0x01, 0, 0] }]
    }
  },
  {
    name: "bsf32-memory-source-fault",
    bytes: [0x0f, 0xbc, 0x05, 0xfe, 0xff, 0x00, 0x00],
    initialState: {
      eax: 0xaaaa_5555,
      CF: 1,
      PF: 0,
      AF: 1,
      ZF: 0,
      SF: 1,
      OF: 1,
      eip: startAddress
    },
    expected: {
      stop: { kind: "cpuException", exception: pageFault(0xfffe, 0) },
      state: {
        eax: 0xaaaa_5555,
        CF: 1,
        PF: 0,
        AF: 1,
        ZF: 0,
        SF: 1,
        OF: 1,
        eip: startAddress,
        instructionCount: 0
      }
    }
  },
  {
    name: "bsr32-nonzero/trap",
    bytes: [0x0f, 0xbd, 0xc3, ...trap],
    initialState: {
      eax: 0xaaaa_5555,
      ebx: 0x120,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 8,
        ebx: 0x120,
        ...scanFlags(8, 0),
        eip: startAddress + 5,
        instructionCount: 2
      }
    }
  },
  {
    name: "bsr16-memory-source-nonzero/trap",
    bytes: [0x66, 0x0f, 0xbd, 0x05, 0x24, 0x00, 0x00, 0x00, ...trap],
    initialState: {
      eax: 0xaaaa_0000,
      CF: 1,
      PF: 0,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1,
      eip: startAddress
    },
    initialMemory: [{ address: 0x24, bytes: [0x20, 0x00] }],
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0xaaaa_0005,
        ...scanFlags(5, 0),
        eip: startAddress + 10,
        instructionCount: 2
      },
      memory: [{ address: 0x24, bytes: [0x20, 0x00] }]
    }
  },
  {
    name: "bsr16-nonzero/trap",
    bytes: [0x66, 0x0f, 0xbd, 0xc3, ...trap],
    initialState: {
      eax: 0xaaaa_0000,
      ebx: 0x20,
      CF: 1,
      PF: 0,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0xaaaa_0005,
        ebx: 0x20,
        ...scanFlags(5, 0),
        eip: startAddress + 6,
        instructionCount: 2
      }
    }
  },
  {
    name: "bsr16-zero-preserves-destination/trap",
    bytes: [0x66, 0x0f, 0xbd, 0xc3, ...trap],
    initialState: {
      eax: 0xaaaa_1234,
      ebx: 0,
      CF: 1,
      PF: 0,
      AF: 1,
      ZF: 0,
      SF: 1,
      OF: 1,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0xaaaa_1234,
        ebx: 0,
        ...scanFlags(0, 1),
        eip: startAddress + 6,
        instructionCount: 2
      }
    }
  }
] as const satisfies readonly InstructionFixture[];

registerInstructionFixtures(fixtures);

function scanFlags(indexForParity: number, zf: 0 | 1): Readonly<Record<"CF" | "PF" | "AF" | "ZF" | "SF" | "OF", number>> {
  return {
    CF: 0,
    PF: evenParity(indexForParity & 0xff) ? 1 : 0,
    AF: 0,
    ZF: zf,
    SF: 0,
    OF: 0
  };
}

function evenParity(value: number): boolean {
  let remaining = value & 0xff;
  let parity = 0;

  while (remaining !== 0) {
    parity ^= remaining & 1;
    remaining >>>= 1;
  }

  return parity === 0;
}
