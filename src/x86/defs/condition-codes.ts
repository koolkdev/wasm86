import type { ConditionCode } from "#x86/conditions.js";

export type ConditionCodeDescriptor = Readonly<{
  opcodeLow: number;
  suffix: string;
  cc: ConditionCode;
}>;

export const CONDITION_CODE_DESCRIPTORS = [
  // cc=0: overflow
  { opcodeLow: 0x0, suffix: "o", cc: "O" },
  // cc=1: not overflow
  { opcodeLow: 0x1, suffix: "no", cc: "NO" },
  // cc=2: below/carry
  { opcodeLow: 0x2, suffix: "b", cc: "B" },
  // cc=3: above or equal/not carry
  { opcodeLow: 0x3, suffix: "ae", cc: "AE" },
  // cc=4: equal/zero
  { opcodeLow: 0x4, suffix: "e", cc: "E" },
  // cc=5: not equal/not zero
  { opcodeLow: 0x5, suffix: "ne", cc: "NE" },
  // cc=6: below or equal
  { opcodeLow: 0x6, suffix: "be", cc: "BE" },
  // cc=7: above
  { opcodeLow: 0x7, suffix: "a", cc: "A" },
  // cc=8: sign
  { opcodeLow: 0x8, suffix: "s", cc: "S" },
  // cc=9: not sign
  { opcodeLow: 0x9, suffix: "ns", cc: "NS" },
  // cc=A: parity
  { opcodeLow: 0xa, suffix: "p", cc: "P" },
  // cc=B: not parity
  { opcodeLow: 0xb, suffix: "np", cc: "NP" },
  // cc=C: less
  { opcodeLow: 0xc, suffix: "l", cc: "L" },
  // cc=D: greater or equal
  { opcodeLow: 0xd, suffix: "ge", cc: "GE" },
  // cc=E: less or equal
  { opcodeLow: 0xe, suffix: "le", cc: "LE" },
  // cc=F: greater
  { opcodeLow: 0xf, suffix: "g", cc: "G" }
] as const satisfies readonly ConditionCodeDescriptor[];
