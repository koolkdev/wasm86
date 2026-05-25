import {
  x86ArithmeticEflagsMask,
  x86ArithmeticFlags,
  x86ControlEflagsMask,
  x86ControlFlags,
  x86EflagsFieldMask,
  x86EflagsMask,
  x86SupportedEflagsMask,
  type X86ArithmeticFlag,
  type X86ControlFlag,
  type X86EflagsFlag
} from "#x86/isa/flags.js";
import { reg32, widthMask, type RegisterAlias, type Reg32 } from "#x86/isa/types.js";
import { u32 } from "#x86/numeric.js";

export type CpuArithmeticFlag = X86ArithmeticFlag;
export type CpuControlFlag = X86ControlFlag;
export type CpuFlag = X86EflagsFlag;

export type CpuState = {
  [Register in Reg32]: number;
} & {
  eip: number;
  eflags: number;
  instructionCount: number;
  stopReason: number;
};

export const cpuArithmeticFlags = x86ArithmeticFlags;
export const cpuControlFlags = x86ControlFlags;
export const cpuFlags = [...cpuArithmeticFlags, ...cpuControlFlags] as const satisfies readonly CpuFlag[];

export const eflagsMask = x86EflagsMask;
export const eflagsFieldMask = x86EflagsFieldMask;

export const arithmeticEflagsMask = x86ArithmeticEflagsMask;
export const controlEflagsMask = x86ControlEflagsMask;
export const supportedEflagsMask = x86SupportedEflagsMask;

export const cpuStateFields = [...reg32, "eip", "eflags", "instructionCount", "stopReason"] as const satisfies readonly (keyof CpuState)[];
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
    eflags: 0,
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

export function getFlag(state: CpuState, flag: CpuFlag): boolean {
  return (state.eflags & eflagsMask[flag]) !== 0;
}

export function setFlag(state: CpuState, flag: CpuFlag, value: boolean): void {
  const mask = eflagsMask[flag];
  state.eflags = value ? u32(state.eflags | mask) : u32(state.eflags & ~mask);
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

  return state;
}
