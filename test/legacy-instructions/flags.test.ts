import { startAddress } from "#test/support/addresses.js";
import type { InstructionFixture } from "#test/support/instruction-fixture.js";
import { registerInstructionFixtures } from "./support.js";

const trap = [0xcd, 0x2e] as const;

const fixtures = [
  {
    name: "cmc-resolves-lazy-cf/trap",
    // add eax, 1; cmc; int 0x2e
    bytes: [0x83, 0xc0, 0x01, 0xf5, ...trap],
    initialState: {
      eax: 0xffff_ffff,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0,
        eip: startAddress + 6,
        instructionCount: 3,
        CF: 0,
        PF: 1,
        AF: 1,
        ZF: 1,
        SF: 0,
        OF: 0
      }
    }
  },
  {
    name: "std-cld-round-trip-through-pushfd/trap",
    // std; pushfd; pop eax; cld; pushfd; pop ebx; int 0x2e
    bytes: [0xfd, 0x9c, 0x58, 0xfc, 0x9c, 0x5b, ...trap],
    initialState: {
      esp: 0x80,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0x602,
        ebx: 0x202,
        esp: 0x80,
        DF: 0,
        eip: startAddress + 8,
        instructionCount: 7
      }
    }
  },
  {
    name: "sahf-lahf-round-trip-low-flags/trap",
    // sahf; lahf; int 0x2e
    bytes: [0x9e, 0x9f, ...trap],
    initialState: {
      eax: 0x1234_6f00,
      OF: 1,
      eip: startAddress
    },
    expected: {
      stop: { kind: "hostTrap", vector: 0x2e },
      state: {
        eax: 0x1234_4700,
        CF: 1,
        PF: 1,
        AF: 0,
        ZF: 1,
        SF: 0,
        OF: 1,
        eip: startAddress + 4,
        instructionCount: 3
      }
    }
  }
] as const satisfies readonly InstructionFixture[];

registerInstructionFixtures(fixtures);
