export type X86ArithmeticFlag = "CF" | "PF" | "AF" | "ZF" | "SF" | "OF";
export type X86ControlFlag = "TF" | "IF" | "DF" | "NT" | "RF" | "VM" | "AC" | "ID";
export type X86EflagsFlag = X86ArithmeticFlag | X86ControlFlag;
export type X86EflagsField = "IOPL";

export const x86ArithmeticFlags = ["CF", "PF", "AF", "ZF", "SF", "OF"] as const satisfies readonly X86ArithmeticFlag[];
export const x86ControlFlags = ["TF", "IF", "DF", "NT", "RF", "VM", "AC", "ID"] as const satisfies readonly X86ControlFlag[];

export const x86ArithmeticFlagMask = {
  CF: 1 << 0,
  PF: 1 << 1,
  AF: 1 << 2,
  ZF: 1 << 3,
  SF: 1 << 4,
  OF: 1 << 5
} as const satisfies Readonly<Record<X86ArithmeticFlag, number>>;

export const x86EflagsMask = {
  CF: 1 << 0,
  PF: 1 << 2,
  AF: 1 << 4,
  ZF: 1 << 6,
  SF: 1 << 7,
  TF: 1 << 8,
  IF: 1 << 9,
  DF: 1 << 10,
  OF: 1 << 11,
  NT: 1 << 14,
  RF: 1 << 16,
  VM: 1 << 17,
  AC: 1 << 18,
  ID: 1 << 21
} as const satisfies Readonly<Record<X86EflagsFlag, number>>;

export const x86EflagsFieldMask = {
  IOPL: 0b11 << 12
} as const satisfies Readonly<Record<X86EflagsField, number>>;

export const x86ArithmeticEflagsMask = maskEflags(x86ArithmeticFlags);
export const x86ControlEflagsMask = (
  maskEflags(x86ControlFlags) |
  x86EflagsFieldMask.IOPL
) >>> 0;
export const x86SupportedEflagsMask = (x86ArithmeticEflagsMask | x86ControlEflagsMask) >>> 0;
export const x86ArithmeticFlagsMask = maskArithmeticFlags(x86ArithmeticFlags);
export const x86NonArithmeticEflagsMask = (~x86ArithmeticEflagsMask) >>> 0;

export function x86ArithmeticFlagsFromEflags(eflags: number): number {
  let aluFlags = 0;

  for (const flag of x86ArithmeticFlags) {
    if ((eflags & x86EflagsMask[flag]) !== 0) {
      aluFlags |= x86ArithmeticFlagMask[flag];
    }
  }

  return aluFlags >>> 0;
}

export function x86ArithmeticFlagsToEflags(aluFlags: number): number {
  let eflags = 0;

  for (const flag of x86ArithmeticFlags) {
    if ((aluFlags & x86ArithmeticFlagMask[flag]) !== 0) {
      eflags |= x86EflagsMask[flag];
    }
  }

  return eflags >>> 0;
}

export function x86ControlFlagsFromEflags(eflags: number): number {
  return (eflags & x86NonArithmeticEflagsMask) >>> 0;
}

export function x86MergeSplitEflags(aluFlags: number, ctrlFlags: number): number {
  return (x86ArithmeticFlagsToEflags(aluFlags) | (ctrlFlags & x86NonArithmeticEflagsMask)) >>> 0;
}

function maskEflags(flags: Iterable<X86EflagsFlag>): number {
  let mask = 0;

  for (const flag of flags) {
    mask |= x86EflagsMask[flag];
  }

  return mask >>> 0;
}

function maskArithmeticFlags(flags: Iterable<X86ArithmeticFlag>): number {
  let mask = 0;

  for (const flag of flags) {
    mask |= x86ArithmeticFlagMask[flag];
  }

  return mask >>> 0;
}
