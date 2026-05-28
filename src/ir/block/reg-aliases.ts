import { registerAlias, registerAliasesByWidth } from "#x86/registers.js";
import {
  widthMask,
  type Reg32,
  type RegisterAlias
} from "#x86/types.js";

function regAliasForMask(reg: Reg32, mask: number): RegisterAlias {
  const aliases = [...regAliasesForBase(reg)]
    .sort((left: RegisterAlias, right: RegisterAlias) => left.width - right.width);

  for (const alias of aliases) {
    if ((mask & ~regAliasMask(alias)) === 0) {
      return alias;
    }
  }

  return registerAlias(reg);
}

export function regAliasForRange(reg: Reg32, offset: number, width: number): RegisterAlias {
  return regAliasForMask(reg, regAliasRangeMask(offset, width));
}

export function regAliasContaining(left: RegisterAlias, right: RegisterAlias): RegisterAlias {
  if (left.base !== right.base) {
    throw new Error(`cannot merge aliases from different base registers: ${left.name}, ${right.name}`);
  }

  return regAliasForMask(left.base, (regAliasMask(left) | regAliasMask(right)) >>> 0);
}

export function regAliasesOverlap(left: RegisterAlias, right: RegisterAlias): boolean {
  return left.base === right.base && ((regAliasMask(left) & regAliasMask(right)) >>> 0) !== 0;
}

function regAliasMask(alias: RegisterAlias): number {
  return (widthMask(alias.width) << alias.bitOffset) >>> 0;
}

function regAliasRangeMask(offset: number, width: number): number {
  if (!Number.isInteger(offset) || !Number.isInteger(width) || offset < 0 || width < 0) {
    throw new Error("register alias range must be a non-negative integer bit range");
  }

  if (width === 0 || offset >= 32) {
    return 0;
  }

  const end = Math.min(32, offset + width);

  if (end <= offset) {
    return 0;
  }

  if (offset === 0 && end === 32) {
    return 0xffff_ffff;
  }

  return (((2 ** (end - offset)) - 1) * (2 ** offset)) >>> 0;
}

function regAliasesForBase(reg: Reg32): readonly RegisterAlias[] {
  return Object.freeze(
    Object.values(registerAliasesByWidth)
      .flat()
      .filter((alias) => alias.base === reg)
  );
}
