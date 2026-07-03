import type { EngineFixture } from "./types.js";

export const engineFixtureStartAddress = 0x1000;

export const MOV_ADD_TRAP = {
  name: "mov/add/trap",
  bytes: [
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0x83, 0xc0, 0x02,
    0xcd, 0x2e
  ],
  initialState: { eip: engineFixtureStartAddress },
  expected: {
    result: {
      stop: { kind: "hostTrap", vector: 0x2e }
    },
    state: {
      eax: 3,
      eip: engineFixtureStartAddress + 10,
      instructionCount: 3
    }
  }
} satisfies EngineFixture;

export const MEMORY_STORE_TRAP = {
  name: "memory-store/trap",
  bytes: [
    0x89, 0x05, 0x20, 0x00, 0x00, 0x00,
    0xcd, 0x2e
  ],
  initialState: {
    eax: 0x1234_5678,
    eip: engineFixtureStartAddress
  },
  expected: {
    result: {
      stop: { kind: "hostTrap", vector: 0x2e }
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
    eip: engineFixtureStartAddress
  },
  expected: {
    result: {
      stop: { kind: "hostTrap", vector: 0x2e }
    },
    state: {
      eax: 0,
      eip: engineFixtureStartAddress + 10,
      instructionCount: 10
    }
  }
} satisfies EngineFixture;

export const UNSUPPORTED_OPCODE = {
  name: "unsupported-opcode",
  bytes: [0x62],
  initialState: { eip: engineFixtureStartAddress },
  expected: {
    result: {
      stop: { kind: "unsupported", reason: "unsupportedOpcode" }
    },
    state: {
      eip: engineFixtureStartAddress,
      instructionCount: 0
    }
  }
} satisfies EngineFixture;

export const ENGINE_PROGRAM_FIXTURES = [
  MOV_ADD_TRAP,
  MEMORY_STORE_TRAP,
  COUNTDOWN_BRANCH_TRAP,
  UNSUPPORTED_OPCODE
] as const satisfies readonly EngineFixture[];
