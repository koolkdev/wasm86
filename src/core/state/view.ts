import { u32 } from "#common/numeric.js";
import { widthMask, type RegisterAlias, type Reg32, type SegmentRegister } from "#core/types.js";

export interface CoreStateView {
  readonly eip: number;

  readReg32(reg: Reg32): number;
  readSegmentSelector(reg: SegmentRegister): number;
  readSegmentBase(reg: SegmentRegister): number;
  readSegmentLimit(reg: SegmentRegister): number;
  readSegmentAccess(reg: SegmentRegister): number;
}

export interface MutableCoreStateView extends CoreStateView {
  eip: number;

  writeReg32(reg: Reg32, value: number): void;
  writeSegmentSelector(reg: SegmentRegister, value: number): void;
  writeSegmentBase(reg: SegmentRegister, value: number): void;
  writeSegmentLimit(reg: SegmentRegister, value: number): void;
  writeSegmentAccess(reg: SegmentRegister, value: number): void;
}

export function readRegisterAlias(state: CoreStateView, alias: RegisterAlias): number {
  const value = state.readReg32(alias.base);

  return alias.width === 32 ? value : (value >>> alias.bitOffset) & widthMask(alias.width);
}

export function writeRegisterAlias(
  state: MutableCoreStateView,
  alias: RegisterAlias,
  value: number
): void {
  if (alias.width === 32) {
    state.writeReg32(alias.base, value);
    return;
  }

  const mask = widthMask(alias.width) << alias.bitOffset;
  const base = state.readReg32(alias.base);

  state.writeReg32(alias.base, u32((base & ~mask) | ((value << alias.bitOffset) & mask)));
}
