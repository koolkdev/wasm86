export type X86Flag = "CF" | "PF" | "AF" | "ZF" | "SF" | "OF";

export const x86Flags = ["CF", "PF", "AF", "ZF", "SF", "OF"] as const satisfies readonly X86Flag[];

export const x86EflagsMask = {
  CF: 1 << 0,
  PF: 1 << 2,
  AF: 1 << 4,
  ZF: 1 << 6,
  SF: 1 << 7,
  OF: 1 << 11
} as const satisfies Readonly<Record<X86Flag, number>>;
