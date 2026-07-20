import { startAddress } from "#test/support/addresses.js";
import type { InstructionFixture } from "#test/support/instruction-fixture.js";

export const MOV_ADD_TRAP = {
  name: "mov/add/trap",
  bytes: [
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0x83, 0xc0, 0x02,
    0xcd, 0x2e
  ],
  initialState: { eip: startAddress },
  expected: {
    stop: { kind: "hostTrap", vector: 0x2e },
    state: {
      eax: 3,
      eip: startAddress + 10,
      instructionCount: 3
    }
  }
} satisfies InstructionFixture;

export const MEMORY_STORE_TRAP = {
  name: "memory-store/trap",
  bytes: [
    0x89, 0x05, 0x20, 0x00, 0x00, 0x00,
    0xcd, 0x2e
  ],
  initialState: {
    eax: 0x1234_5678,
    eip: startAddress
  },
  expected: {
    stop: { kind: "hostTrap", vector: 0x2e },
    state: {
      eax: 0x1234_5678,
      eip: startAddress + 8,
      instructionCount: 2
    },
    memory: [
      { address: 0x20, bytes: [0x78, 0x56, 0x34, 0x12] }
    ]
  }
} satisfies InstructionFixture;

export const COUNTDOWN_BRANCH_TRAP = {
  name: "countdown-branch/trap",
  bytes: [
    0x83, 0xe8, 0x01,
    0x83, 0xf8, 0x00,
    0x75, 0xf8,
    0xcd, 0x2e
  ],
  initialState: {
    eax: 3,
    eip: startAddress
  },
  expected: {
    stop: { kind: "hostTrap", vector: 0x2e },
    state: {
      eax: 0,
      eip: startAddress + 10,
      instructionCount: 10
    }
  }
} satisfies InstructionFixture;

export const ECX_LOOP_TRAP = {
  name: "ecx-loop/trap",
  bytes: [
    0xe2, 0xfe,
    0xcc
  ],
  initialState: {
    ecx: 3,
    eip: startAddress,
    CF: 1,
    PF: 1,
    AF: 1,
    ZF: 1,
    SF: 1,
    OF: 1
  },
  expected: {
    stop: { kind: "hostTrap", vector: 3 },
    state: {
      ecx: 0,
      eip: startAddress + 3,
      instructionCount: 4,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1
    }
  }
} satisfies InstructionFixture;

export const LOOPE_ZF_CLEAR_TRAP = {
  name: "loope-zf-clear/trap",
  bytes: [
    0xe1, 0xfe,
    0xcc
  ],
  initialState: {
    ecx: 2,
    eip: startAddress
  },
  expected: {
    stop: { kind: "hostTrap", vector: 3 },
    state: {
      ecx: 1,
      eip: startAddress + 3,
      instructionCount: 2,
      ZF: 0
    }
  }
} satisfies InstructionFixture;

export const LOOPNE_ZF_SET_TRAP = {
  name: "loopne-zf-set/trap",
  bytes: [
    0xe0, 0xfe,
    0xcc
  ],
  initialState: {
    ecx: 2,
    eip: startAddress,
    ZF: 1
  },
  expected: {
    stop: { kind: "hostTrap", vector: 3 },
    state: {
      ecx: 1,
      eip: startAddress + 3,
      instructionCount: 2,
      ZF: 1
    }
  }
} satisfies InstructionFixture;

export const JECXZ_TAKEN_TRAP = {
  name: "jecxz-taken/trap",
  bytes: [
    0xe3, 0x02,
    0xcd, 0x2e,
    0xcc
  ],
  initialState: {
    ecx: 0,
    eip: startAddress,
    OF: 1
  },
  expected: {
    stop: { kind: "hostTrap", vector: 3 },
    state: {
      ecx: 0,
      eip: startAddress + 5,
      instructionCount: 2,
      OF: 1
    }
  }
} satisfies InstructionFixture;

export const JECXZ_NOT_TAKEN_TRAP = {
  name: "jecxz-not-taken/trap",
  bytes: JECXZ_TAKEN_TRAP.bytes,
  initialState: {
    ecx: 1,
    eip: startAddress,
    OF: 1
  },
  expected: {
    stop: { kind: "hostTrap", vector: 0x2e },
    state: {
      ecx: 1,
      eip: startAddress + 4,
      instructionCount: 2,
      OF: 1
    }
  }
} satisfies InstructionFixture;

export const INTO_TAKEN_TRAP = {
  name: "into-taken/trap",
  bytes: [
    0xce,
    0xcc
  ],
  initialState: {
    eip: startAddress,
    OF: 1
  },
  expected: {
    stop: { kind: "hostTrap", vector: 4 },
    state: {
      eip: startAddress + 1,
      instructionCount: 1,
      OF: 1
    }
  }
} satisfies InstructionFixture;

export const INTO_NOT_TAKEN_TRAP = {
  name: "into-not-taken/trap",
  bytes: INTO_TAKEN_TRAP.bytes,
  initialState: {
    eip: startAddress
  },
  expected: {
    stop: { kind: "hostTrap", vector: 3 },
    state: {
      eip: startAddress + 2,
      instructionCount: 2,
      OF: 0
    }
  }
} satisfies InstructionFixture;

export const UNSUPPORTED_OPCODE = {
  name: "unsupported-opcode",
  bytes: [0x62],
  initialState: { eip: startAddress },
  expected: {
    stop: { kind: "cpuException", exception: { kind: "UD" } },
    state: {
      eip: startAddress,
      instructionCount: 0
    }
  }
} satisfies InstructionFixture;

export const CPU_PROGRAM_FIXTURES = [
  MOV_ADD_TRAP,
  MEMORY_STORE_TRAP,
  COUNTDOWN_BRANCH_TRAP,
  ECX_LOOP_TRAP,
  LOOPE_ZF_CLEAR_TRAP,
  LOOPNE_ZF_SET_TRAP,
  JECXZ_TAKEN_TRAP,
  JECXZ_NOT_TAKEN_TRAP,
  INTO_TAKEN_TRAP,
  INTO_NOT_TAKEN_TRAP,
  UNSUPPORTED_OPCODE
] as const satisfies readonly InstructionFixture[];
