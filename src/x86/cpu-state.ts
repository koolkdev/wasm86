import type { X86Flag } from "./flags.js";
import { u32 } from "./numeric.js";
import { widthMask, type RegisterAlias, type Reg32, type SegmentRegister } from "./types.js";

export interface CpuStateView {
  readonly eip: number;

  readReg32(reg: Reg32): number;
  readSegmentSelector(reg: SegmentRegister): number;
  readSegmentBase(reg: SegmentRegister): number;
  readFlag(flag: X86Flag): boolean;
}

export interface MutableCpuStateView extends CpuStateView {
  eip: number;

  writeReg32(reg: Reg32, value: number): void;
  writeSegmentSelector(reg: SegmentRegister, value: number): void;
  writeSegmentBase(reg: SegmentRegister, value: number): void;
  writeFlag(flag: X86Flag, value: boolean): void;
}

export function readRegisterAlias(state: CpuStateView, alias: RegisterAlias): number {
  const value = state.readReg32(alias.base);

  return alias.width === 32
    ? value
    : (value >>> alias.bitOffset) & widthMask(alias.width);
}

export function writeRegisterAlias(state: MutableCpuStateView, alias: RegisterAlias, value: number): void {
  if (alias.width === 32) {
    state.writeReg32(alias.base, value);
    return;
  }

  const mask = widthMask(alias.width) << alias.bitOffset;
  const base = state.readReg32(alias.base);

  state.writeReg32(alias.base, u32((base & ~mask) | ((value << alias.bitOffset) & mask)));
}
