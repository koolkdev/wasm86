export const x86StatusFlags = [
  "CF",
  "PF",
  "AF",
  "ZF",
  "SF",
  "OF"
] as const;
const x86NonStatusFlags = [
  "TF",
  "DF",
  "NT",
  "AC",
  "ID"
] as const;
export const x86Flags = [
  ...x86StatusFlags,
  ...x86NonStatusFlags
] as const;

export type X86StatusFlag = (typeof x86StatusFlags)[number];
export type X86Flag = (typeof x86Flags)[number];

export function isX86StatusFlag(flag: X86Flag): flag is X86StatusFlag {
  return (x86StatusFlags as readonly X86Flag[]).includes(flag);
}

export const x86EflagsBitOffset = {
  CF: 0,
  PF: 2,
  AF: 4,
  ZF: 6,
  SF: 7,
  OF: 11,
  TF: 8,
  DF: 10,
  NT: 14,
  AC: 18,
  ID: 21
} as const satisfies Readonly<Record<X86Flag, number>>;
