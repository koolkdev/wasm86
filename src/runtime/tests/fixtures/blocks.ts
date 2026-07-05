import type { EngineFixture } from "./types.js";
import { engineFixtureStartAddress } from "./programs.js";

export const MOV_ADD_JUMP_BLOCK = {
  name: "mov/add/jump",
  bytes: [
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0x83, 0xc0, 0x02,
    0xeb, 0x00
  ],
  initialState: { eip: engineFixtureStartAddress },
  expected: {
    result: {
      stop: { kind: "none" }
    },
    state: {
      eax: 3,
      eip: engineFixtureStartAddress + 10,
      instructionCount: 3
    }
  }
} satisfies EngineFixture;

export const MEMORY_STORE_JUMP_BLOCK = {
  name: "memory-store/jump",
  bytes: [
    0x89, 0x05, 0x20, 0x00, 0x00, 0x00,
    0xeb, 0x00
  ],
  initialState: {
    eax: 0x1234_5678,
    eip: engineFixtureStartAddress
  },
  expected: {
    result: {
      stop: { kind: "none" }
    },
    state: {
      eax: 0x1234_5678,
      eip: engineFixtureStartAddress + 8,
      instructionCount: 2
    },
    memory: [
      { address: 0x20, bytes: [0x78, 0x56, 0x34, 0x12] }
    ]
  }
} satisfies EngineFixture;

export const CMP_BRANCH_TAKEN_BLOCK = {
  name: "cmp/branch-taken",
  bytes: [
    0x83, 0xf8, 0x00,
    0x75, 0x02
  ],
  initialState: {
    eax: 1,
    eip: engineFixtureStartAddress
  },
  expected: {
    result: {
      stop: { kind: "none" }
    },
    state: {
      eax: 1,
      eip: engineFixtureStartAddress + 7,
      instructionCount: 2
    }
  }
} satisfies EngineFixture;

export const LOOP_EXIT_BLOCK = {
  name: "loop-exit",
  bytes: [
    0xe2, 0x00
  ],
  initialState: {
    ecx: 1,
    eip: engineFixtureStartAddress,
    CF: 1,
    PF: 1,
    AF: 1,
    ZF: 1,
    SF: 1,
    OF: 1
  },
  expected: {
    result: {
      stop: { kind: "none" }
    },
    state: {
      ecx: 0,
      eip: engineFixtureStartAddress + 2,
      instructionCount: 1,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 1,
      OF: 1
    }
  }
} satisfies EngineFixture;

export const JECXZ_TAKEN_BLOCK = {
  name: "jecxz-taken",
  bytes: [
    0xe3, 0x02
  ],
  initialState: {
    ecx: 0,
    eip: engineFixtureStartAddress,
    OF: 1
  },
  expected: {
    result: {
      stop: { kind: "none" }
    },
    state: {
      ecx: 0,
      eip: engineFixtureStartAddress + 4,
      instructionCount: 1,
      OF: 1
    }
  }
} satisfies EngineFixture;

export const INTO_NOT_TAKEN_BLOCK = {
  name: "into-not-taken",
  bytes: [
    0xce
  ],
  initialState: {
    eip: engineFixtureStartAddress
  },
  expected: {
    result: {
      stop: { kind: "none" }
    },
    state: {
      eip: engineFixtureStartAddress + 1,
      instructionCount: 1,
      OF: 0
    }
  }
} satisfies EngineFixture;

export const COMPILED_BLOCK_FIXTURES = [
  MOV_ADD_JUMP_BLOCK,
  MEMORY_STORE_JUMP_BLOCK,
  CMP_BRANCH_TAKEN_BLOCK,
  LOOP_EXIT_BLOCK,
  JECXZ_TAKEN_BLOCK,
  INTO_NOT_TAKEN_BLOCK
] as const satisfies readonly EngineFixture[];
