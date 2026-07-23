import { test } from "node:test";

import {
  assertInstructionCase,
  type InstructionCase
} from "#test/harness/instruction-case.js";
import { startAddress } from "#test/support/addresses.js";

const allFlagsSet = {
  CF: 1,
  PF: 1,
  AF: 1,
  ZF: 1,
  SF: 1,
  OF: 1
} as const;

const allFlagsClear = {
  CF: 0,
  PF: 0,
  AF: 0,
  ZF: 0,
  SF: 0,
  OF: 0
} as const;

const nonStatusFlags = {
  TF: 1,
  DF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

const adjustmentCases = [
  {
    name: "DAA performs both low and high decimal adjustments",
    bytes: [0x27],
    initialState: { eax: 0xaaaa_009a, ...allFlagsClear, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_0000,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "DAS applies an incoming carry adjustment",
    bytes: [0x2f],
    initialState: { eax: 0xaaaa_0080, ...allFlagsClear, CF: 1, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_0020,
      CF: 1,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "DAS reports a borrow from the low decimal adjustment",
    bytes: [0x2f],
    initialState: { eax: 0xaaaa_0000, ...allFlagsClear, AF: 1, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_00fa,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 0,
      SF: 1,
      OF: 0
    }
  },
  {
    name: "AAA adjusts AX and derives the explicit undefined-flag policy from final AL",
    bytes: [0x37],
    initialState: { eax: 0xaaaa_120a, ...allFlagsClear, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_1300,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "AAA carries from AL into AH during its AX adjustment",
    bytes: [0x37],
    initialState: { eax: 0xaaaa_12fa, ...allFlagsClear, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_1400,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 1,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "AAS adjusts AX and derives the explicit undefined-flag policy from final AL",
    bytes: [0x3f],
    initialState: { eax: 0xaaaa_120a, ...allFlagsClear, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_1104,
      CF: 1,
      PF: 0,
      AF: 1,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "AAS borrows from AH during its AX adjustment",
    bytes: [0x3f],
    initialState: { eax: 0xaaaa_1200, ...allFlagsClear, AF: 1, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_100a,
      CF: 1,
      PF: 1,
      AF: 1,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "AAM base ten splits AL into decimal digits in AH and AL",
    bytes: [0xd4, 0x0a],
    initialState: { eax: 0xaaaa_7763, ...allFlagsSet, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_0909,
      CF: 0,
      PF: 1,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "AAM accepts a non-decimal immediate base",
    bytes: [0xd4, 0x02],
    initialState: { eax: 0xaaaa_77ff, ...allFlagsSet, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_7f01,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "AAD base ten combines AH and AL without touching high EAX",
    bytes: [0xd5, 0x0a],
    initialState: { eax: 0xaaaa_010f, ...allFlagsSet, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_0019,
      CF: 0,
      PF: 0,
      AF: 1,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  },
  {
    name: "AAD applies byte-width carry and overflow for a large base",
    bytes: [0xd5, 0x80],
    initialState: { eax: 0xaaaa_0180, ...allFlagsSet, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_0000,
      CF: 1,
      PF: 1,
      AF: 0,
      ZF: 1,
      SF: 0,
      OF: 1
    }
  },
  {
    name: "AAD base zero keeps AL while clearing AH",
    bytes: [0xd5, 0x00],
    initialState: { eax: 0xaaaa_1234, ...allFlagsSet, ...nonStatusFlags },
    expectedState: {
      eax: 0xaaaa_0034,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    }
  }
] as const satisfies readonly InstructionCase[];

for (const entry of adjustmentCases) {
  test(entry.name, async () => {
    await assertInstructionCase(entry);
  });
}

test("AAM base zero raises divide error without changing architectural state", async () => {
  await assertInstructionCase({
    name: "AAM base-zero divide error",
    bytes: [0xd4, 0x00],
    initialState: { eax: 0xaaaa_1234, ...allFlagsSet, ...nonStatusFlags },
    expectedCompletion: {
      kind: "cpuException",
      exception: { kind: "DE" }
    },
    expectedEip: startAddress,
    instructionCount: 0
  });
});
