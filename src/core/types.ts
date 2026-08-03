export const reg32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"] as const;
export const reg16 = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"] as const;
export const reg8 = ["al", "cl", "dl", "bl", "ah", "ch", "dh", "bh"] as const;
export const segmentRegisters = ["es", "cs", "ss", "ds", "fs", "gs"] as const;

export type Reg32 = (typeof reg32)[number];
export type Reg16 = (typeof reg16)[number];
export type Reg8 = (typeof reg8)[number];
export type RegName = Reg8 | Reg16 | Reg32;
export type SegmentRegister = (typeof segmentRegisters)[number];
export type OperandWidth = 8 | 16 | 32;
export type MemoryOperandWidth = OperandWidth | 64;

type RegisterNameByWidth = Readonly<{
  8: Reg8;
  16: Reg16;
  32: Reg32;
}>;

export type RegisterNameForWidth<Width extends OperandWidth> = RegisterNameByWidth[Width];

export type RegisterWidth<Name extends RegName> = Name extends Reg8
  ? 8
  : Name extends Reg16
    ? 16
    : 32;

export type RegisterAlias = Readonly<{
  name: RegName;
  base: Reg32;
  bitOffset: 0 | 8;
  width: OperandWidth;
}>;

export type RegisterAliasFor<Name extends RegName> = RegisterAlias &
  Readonly<{
    name: Name;
    width: RegisterWidth<Name>;
  }>;

export type EffectiveAddress = Readonly<{
  segment: SegmentRegister | undefined;
  base: Reg32 | undefined;
  index: Reg32 | undefined;
  scale: 1 | 2 | 4 | 8;
  disp: number;
}>;

export type MemOperand = EffectiveAddress &
  Readonly<{
    kind: "mem";
    accessWidth: MemoryOperandWidth;
  }>;

export type Mem32Operand = MemOperand & Readonly<{ accessWidth: 32 }>;

export function widthMask(width: OperandWidth): number {
  return width === 32 ? 0xffff_ffff : width === 16 ? 0xffff : 0xff;
}
