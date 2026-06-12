import { x86Flags, type X86Flag } from "#x86/flags.js";
import { reg32, widthMask, type RegisterAlias, type Reg32 } from "#x86/types.js";
import { u32 } from "#x86/numeric.js";

export type CpuFlag = X86Flag;

export type CpuState = {
  [Register in Reg32]: number;
} & {
  [Flag in CpuFlag]: number;
} & {
  eip: number;
  instructionCount: number;
  stopReason: number;
};

export const cpuFlags = x86Flags;

export const cpuStateFields = [...reg32, "eip", ...cpuFlags, "instructionCount", "stopReason"] as const satisfies readonly (keyof CpuState)[];
export type CpuStateField = (typeof cpuStateFields)[number];

export function createCpuState(overrides: Partial<CpuState> = {}): CpuState {
  return normalizeCpuState({
    eax: 0,
    ecx: 0,
    edx: 0,
    ebx: 0,
    esp: 0,
    ebp: 0,
    esi: 0,
    edi: 0,
    eip: 0,
    CF: 0,
    PF: 0,
    AF: 0,
    ZF: 0,
    SF: 0,
    OF: 0,
    instructionCount: 0,
    stopReason: 0,
    ...overrides
  });
}

export function getReg32(state: CpuState, reg: Reg32): number {
  return state[reg] >>> 0;
}

export function setReg32(state: CpuState, reg: Reg32, value: number): void {
  state[reg] = u32(value);
}

export function getRegisterAlias(state: CpuState, alias: RegisterAlias): number {
  const value = getReg32(state, alias.base);

  return alias.width === 32
    ? value
    : (value >>> alias.bitOffset) & widthMask(alias.width);
}

export function setRegisterAlias(state: CpuState, alias: RegisterAlias, value: number): void {
  if (alias.width === 32) {
    setReg32(state, alias.base, value);
    return;
  }

  const mask = widthMask(alias.width) << alias.bitOffset;
  const base = getReg32(state, alias.base);

  setReg32(state, alias.base, (base & ~mask) | ((value << alias.bitOffset) & mask));
}

export function flagsOf(state: Pick<CpuState, CpuFlag>): Readonly<Record<CpuFlag, number>> {
  return { CF: state.CF, PF: state.PF, AF: state.AF, ZF: state.ZF, SF: state.SF, OF: state.OF };
}

export function getFlag(state: CpuState, flag: CpuFlag): boolean {
  return state[flag] !== 0;
}

export function setFlag(state: CpuState, flag: CpuFlag, value: boolean): void {
  state[flag] = value ? 1 : 0;
}

export function hasEvenParityLowByte(value: number): boolean {
  let remaining = value & 0xff;
  let isEven = true;

  while (remaining !== 0) {
    isEven = !isEven;
    remaining &= remaining - 1;
  }

  return isEven;
}

export function cloneCpuState(state: CpuState): CpuState {
  return createCpuState(state);
}

export function copyCpuState(source: CpuState, target: CpuState): void {
  for (const field of cpuStateFields) {
    target[field] = u32(source[field]);
  }
}

export function cpuStatesEqual(left: CpuState, right: CpuState): boolean {
  return cpuStateFields.every((field) => u32(left[field]) === u32(right[field]));
}

function normalizeCpuState(state: CpuState): CpuState {
  for (const field of cpuStateFields) {
    state[field] = u32(state[field]);
  }

  for (const flag of cpuFlags) {
    state[flag] = state[flag] === 0 ? 0 : 1;
  }

  return state;
}
